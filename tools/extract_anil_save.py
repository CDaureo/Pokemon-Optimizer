import argparse
import json
import unicodedata
from pathlib import Path


class RubyObject:
    def __init__(self, class_name, ivars=None):
        self.class_name = class_name
        self.ivars = ivars or {}


class RubyMarshalReader:
    def __init__(self, data):
        self.data = data
        self.pos = 0
        self.symbols = []
        self.objects = []

    def read(self, n=1):
        chunk = self.data[self.pos:self.pos + n]
        if len(chunk) != n:
            raise EOFError("Unexpected end of Marshal data")
        self.pos += n
        return chunk

    def read_byte(self):
        return self.read(1)[0]

    def decode_text(self, raw):
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.decode("cp1252", errors="replace")

    def read_int(self):
        c = self.read_byte()
        if c == 0:
            return 0
        if 5 < c < 128:
            return c - 5
        if 128 <= c < 251:
            return c - 256 + 5
        if 1 <= c <= 4:
            value = int.from_bytes(self.read(c), "little", signed=False)
            return value
        if 252 <= c <= 255:
            n = 256 - c
            value = int.from_bytes(self.read(n), "little", signed=False)
            return value - (1 << (8 * n))
        raise ValueError(f"Invalid integer marker {c}")

    def read_symbol(self):
        start = self.pos
        marker = self.read_byte()
        if marker == ord(":"):
            length = self.read_int()
            value = self.decode_text(self.read(length))
            self.symbols.append(value)
            return value
        if marker == ord(";"):
            return self.symbols[self.read_int()]
        if marker == ord("I"):
            value = self.read_value()
            count = self.read_int()
            for _ in range(count):
                self.read_symbol()
                self.read_value()
            if isinstance(value, str):
                return value
            if isinstance(value, dict) and "__ivar_object__" in value:
                return value["__ivar_object__"]
        raise ValueError(f"Expected symbol, got {chr(marker)!r} at offset {start}")

    def read_key(self):
        start = self.pos
        try:
            return self.read_symbol()
        except ValueError:
            self.pos = start
            value = self.read_value()
            if isinstance(value, dict) and "__ivar_object__" in value:
                value = value["__ivar_object__"]
            return str(value)

    def parse(self):
        major = self.read_byte()
        minor = self.read_byte()
        if (major, minor) != (4, 8):
            raise ValueError(f"Unsupported Marshal version {major}.{minor}")
        return self.read_value()

    def remember(self, obj):
        self.objects.append(obj)
        return obj

    def hash_key(self, value):
        try:
            hash(value)
            return value
        except TypeError:
            return json.dumps(to_jsonable(value), ensure_ascii=False, sort_keys=True)

    def read_value(self):
        marker = self.read_byte()
        ch = chr(marker)
        if ch == "0":
            return None
        if ch == "T":
            return True
        if ch == "F":
            return False
        if ch == "i":
            return self.read_int()
        if ch == "f":
            length = self.read_int()
            raw = self.read(length).decode("ascii", errors="replace")
            if raw == "nan":
                return self.remember(float("nan"))
            if raw == "inf":
                return self.remember(float("inf"))
            if raw == "-inf":
                return self.remember(float("-inf"))
            return self.remember(float(raw))
        if ch == ":":
            length = self.read_int()
            value = self.decode_text(self.read(length))
            self.symbols.append(value)
            return value
        if ch == ";":
            return self.symbols[self.read_int()]
        if ch == "@":
            return self.objects[self.read_int()]
        if ch == '"':
            length = self.read_int()
            return self.remember(self.decode_text(self.read(length)))
        if ch == "[":
            arr = self.remember([])
            count = self.read_int()
            arr.extend(self.read_value() for _ in range(count))
            return arr
        if ch == "{":
            obj = self.remember({})
            count = self.read_int()
            for _ in range(count):
                key = self.hash_key(self.read_value())
                obj[key] = self.read_value()
            return obj
        if ch == "}":
            obj = self.remember({})
            count = self.read_int()
            for _ in range(count):
                key = self.hash_key(self.read_value())
                obj[key] = self.read_value()
            obj["__default__"] = self.read_value()
            return obj
        if ch == "I":
            obj = self.read_value()
            count = self.read_int()
            attrs = {}
            for _ in range(count):
                key = self.read_symbol()
                attrs[key] = self.read_value()
            if isinstance(obj, str) and attrs.get("E") is True:
                return obj
            return {"__ivar_object__": obj, "__ivars__": attrs}
        if ch == "o":
            class_name = self.read_symbol()
            obj = self.remember(RubyObject(class_name))
            count = self.read_int()
            for _ in range(count):
                key = self.read_symbol()
                obj.ivars[key] = self.read_value()
            return obj
        if ch == "u":
            class_name = self.read_symbol()
            length = self.read_int()
            return self.remember({"__userdef__": class_name, "data": self.read(length).hex()})
        if ch == "U":
            class_name = self.read_symbol()
            return self.remember({"__usermarshal__": class_name, "value": self.read_value()})
        if ch == "l":
            sign = self.read_byte()
            length = self.read_int() * 2
            raw = self.read(length)
            value = int.from_bytes(raw, "little", signed=False)
            value = value if sign == ord("+") else -value
            return self.remember(value)
        raise ValueError(f"Unsupported Marshal marker {ch!r} at offset {self.pos - 1}")


def to_jsonable(value):
    if isinstance(value, RubyObject):
        return {"__class__": value.class_name, **{k: to_jsonable(v) for k, v in value.ivars.items()}}
    if isinstance(value, list):
        return [to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    return value


def strip_accents_keep_enye(text):
    placeholders = {
        "ñ": "__LOWER_ENYE__",
        "Ñ": "__UPPER_ENYE__",
    }
    for char, placeholder in placeholders.items():
        text = text.replace(char, placeholder)
    text = "".join(
        char for char in unicodedata.normalize("NFD", text)
        if unicodedata.category(char) != "Mn"
    )
    return text.replace("__LOWER_ENYE__", "ñ").replace("__UPPER_ENYE__", "Ñ")


def repair_mojibake(text):
    if not any(marker in text for marker in ("Ã", "Â")):
        return text
    try:
        fixed = text.encode("cp1252").decode("utf-8")
        return fixed
    except UnicodeError:
        return text


def sanitize_text(value):
    if isinstance(value, str):
        value = repair_mojibake(value)
        return strip_accents_keep_enye(value)
    if isinstance(value, list):
        return [sanitize_text(item) for item in value]
    if isinstance(value, dict):
        return {sanitize_text(str(key)): sanitize_text(item) for key, item in value.items()}
    return value


def ivar(obj, name, default=None):
    if isinstance(obj, RubyObject):
        return obj.ivars.get(name, obj.ivars.get(f"@{name}", default))
    return default


def parse_pbs_sections(path):
    entries = {}
    current_id = None
    current = None
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current_id = line[1:-1]
            current = {"id": current_id}
            entries[current_id] = current
            continue
        if current is None or "=" not in line:
            continue
        key, value = line.split("=", 1)
        current[key.strip()] = value.strip()
    return entries


def parse_list(value):
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def parse_level_moves(value):
    parts = parse_list(value)
    moves = []
    for i in range(0, len(parts) - 1, 2):
        try:
            level = int(parts[i])
        except ValueError:
            level = None
        moves.append({"level": level, "id": parts[i + 1]})
    return moves


def load_reference(game_dir):
    pbs = game_dir / "PBS"
    species = parse_pbs_sections(pbs / "pokemon.txt")
    forms = parse_pbs_sections(pbs / "pokemon_forms.txt")
    moves = parse_pbs_sections(pbs / "moves.txt")
    abilities = parse_pbs_sections(pbs / "abilities.txt")
    items = parse_pbs_sections(pbs / "items.txt")
    types = parse_pbs_sections(pbs / "types.txt")
    return species, forms, moves, abilities, items, types


def move_to_dict(move_id, moves_ref, source=None, level=None, compatible=True):
    move_ref = moves_ref.get(str(move_id), {})
    data = {
        "id": move_id,
        "name": move_ref.get("Name") or move_id,
        "type": move_ref.get("Type"),
        "category": move_ref.get("Category"),
        "power": int(move_ref.get("Power", "0") or 0),
        "accuracy": int(move_ref.get("Accuracy", "0") or 0),
        "total_pp": int(move_ref.get("TotalPP", "0") or 0),
        "description": move_ref.get("Description", ""),
        "function_code": move_ref.get("FunctionCode", ""),
        "flags": parse_list(move_ref.get("Flags")),
    }
    if source:
        data["source"] = source
    if level is not None:
        data["level"] = level
    if compatible is not True:
        data["compatible"] = compatible
    return data


def species_data_for(pokemon, species_ref, forms_ref):
    species_id = str(pokemon.get("species"))
    form = pokemon.get("form") or 0
    candidates = [
        f"{species_id},{form}",
        f"{species_id}_{form}",
        species_id,
    ]
    for key in candidates:
        if key in forms_ref:
            merged = dict(species_ref.get(species_id, {}))
            merged.update(forms_ref[key])
            return merged
    return species_ref.get(species_id, {})


def move_id_from_value(value):
    if isinstance(value, RubyObject):
        return ivar(value, "id")
    if isinstance(value, dict):
        return value.get("id") or value.get("@id")
    return value


def random_level_moves_for(pokemon, random_moves):
    species_id = str(pokemon.get("species"))
    species_moves = random_moves.get(species_id)
    if not isinstance(species_moves, dict):
        return []
    form = pokemon.get("form") or 0
    entries = species_moves.get(form) or species_moves.get(0) or []
    moves = []
    for entry in entries:
        if not isinstance(entry, list) or len(entry) < 2:
            continue
        moves.append({"level": entry[0], "id": move_id_from_value(entry[1])})
    return moves


def build_learnable_moves(pokemon, species_data, moves_ref, tm_compatibility, random_moves):
    buckets = {"level": [], "tutor": [], "egg": [], "random_tm": []}
    seen_by_bucket = {key: set() for key in buckets}
    level_source = "random_level"
    level_moves = random_level_moves_for(pokemon, random_moves)
    if not level_moves:
        level_source = "level_pbs_fallback"
        level_moves = parse_level_moves(species_data.get("Moves"))
    for item in level_moves:
        move_id = item["id"]
        if move_id in seen_by_bucket["level"]:
            continue
        seen_by_bucket["level"].add(move_id)
        buckets["level"].append(move_to_dict(move_id, moves_ref, level_source, item["level"]))
    for bucket, field in (("tutor", "TutorMoves"), ("egg", "EggMoves")):
        for move_id in parse_list(species_data.get(field)):
            if move_id in seen_by_bucket[bucket]:
                continue
            seen_by_bucket[bucket].add(move_id)
            buckets[bucket].append(move_to_dict(move_id, moves_ref, bucket))
    species_id = str(pokemon.get("species"))
    for entry in tm_compatibility.get(species_id, []):
        if not isinstance(entry, list) or len(entry) < 2 or entry[1] is not True:
            continue
        move_id = entry[0]
        if move_id in seen_by_bucket["random_tm"]:
            continue
        seen_by_bucket["random_tm"].add(move_id)
        buckets["random_tm"].append(move_to_dict(move_id, moves_ref, "random_tm", compatible=True))
    buckets["all"] = dedupe_moves([move for key in ("level", "tutor", "egg", "random_tm") for move in buckets[key]])
    buckets["level_source"] = level_source
    return buckets


def dedupe_moves(moves):
    seen = set()
    result = []
    for move in moves:
        move_id = move.get("id")
        if move_id in seen:
            continue
        seen.add(move_id)
        result.append(move)
    return result


def pokemon_to_dict(pkmn, box=None, slot=None):
    if not isinstance(pkmn, RubyObject) or pkmn.class_name != "Pokemon":
        return None
    moves = []
    for move in ivar(pkmn, "moves", []) or []:
        if isinstance(move, RubyObject):
            moves.append({"id": ivar(move, "id"), "pp": ivar(move, "pp"), "ppup": ivar(move, "ppup")})
    return {
        "box": box,
        "slot": slot,
        "species": ivar(pkmn, "species"),
        "name": ivar(pkmn, "name"),
        "level": ivar(pkmn, "level"),
        "form": ivar(pkmn, "form", 0),
        "gender": ivar(pkmn, "gender"),
        "ability": ivar(pkmn, "ability"),
        "nature": ivar(pkmn, "nature"),
        "item": ivar(pkmn, "item"),
        "hp": ivar(pkmn, "hp"),
        "totalhp": ivar(pkmn, "totalhp"),
        "attack": ivar(pkmn, "attack"),
        "defense": ivar(pkmn, "defense"),
        "spatk": ivar(pkmn, "spatk"),
        "spdef": ivar(pkmn, "spdef"),
        "speed": ivar(pkmn, "speed"),
        "iv": ivar(pkmn, "iv", {}),
        "ev": ivar(pkmn, "ev", {}),
        "moves": moves,
        "status": ivar(pkmn, "status"),
        "shiny": ivar(pkmn, "shiny"),
    }


def enrich_pokemon(pokemon, species_ref, forms_ref, moves_ref, abilities_ref, tm_compatibility, random_moves):
    species = species_data_for(pokemon, species_ref, forms_ref)
    pokemon["display_name"] = pokemon.get("name") or species.get("Name") or pokemon.get("species")
    pokemon["species_name"] = species.get("Name") or pokemon.get("species")
    pokemon["types"] = parse_list(species.get("Types"))
    pokemon["base_stats"] = parse_list(species.get("BaseStats"))
    ability = pokemon.get("ability")
    ability_ref = abilities_ref.get(str(ability), {})
    pokemon["ability_name"] = ability_ref.get("Name") or ability
    pokemon["ability_description"] = ability_ref.get("Description", "")
    enriched_moves = []
    for move in pokemon["moves"]:
        enriched = dict(move)
        enriched.update(move_to_dict(move.get("id"), moves_ref))
        enriched_moves.append(enriched)
    pokemon["moves"] = enriched_moves
    pokemon["learnable_moves"] = build_learnable_moves(pokemon, species, moves_ref, tm_compatibility, random_moves)
    return pokemon


def item_to_dict(item_id, quantity, items_ref, pocket_index, tm_move_map=None):
    item = items_ref.get(str(item_id), {})
    move = item.get("Move")
    if tm_move_map and item_id in tm_move_map:
        move = move_id_from_value(tm_move_map[item_id])
    return {
        "id": item_id,
        "quantity": quantity,
        "pocket": pocket_index,
        "name": item.get("Name") or item_id,
        "description": item.get("Description", ""),
        "flags": parse_list(item.get("Flags")),
        "field_use": item.get("FieldUse"),
        "battle_use": item.get("BattleUse"),
        "move": move,
        "price": int(item.get("Price", "0") or 0),
        "consumable": item.get("Consumable", "true").lower() != "false",
    }


def export_inventory(bag, items_ref, tm_move_map=None):
    if not isinstance(bag, RubyObject):
        return []
    inventory = []
    for pocket_index, pocket in enumerate(ivar(bag, "pockets", []) or []):
        if not isinstance(pocket, list):
            continue
        for entry in pocket:
            if not isinstance(entry, list) or len(entry) < 2:
                continue
            inventory.append(item_to_dict(entry[0], entry[1], items_ref, pocket_index, tm_move_map))
    return inventory


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--save", required=True)
    parser.add_argument("--game-dir", default=".")
    parser.add_argument("--tm-compatibility")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    game_dir = Path(args.game_dir)
    save_path = Path(args.save)
    reader = RubyMarshalReader(save_path.read_bytes())
    save = reader.parse()
    species_ref, forms_ref, moves_ref, abilities_ref, items_ref, types_ref = load_reference(game_dir)
    tm_path = Path(args.tm_compatibility) if args.tm_compatibility else save_path.with_name(f"tm_compatibility_{save_path.stem.replace(' ', '_')}.dat")
    tm_compatibility = {}
    if tm_path.exists():
        tm_compatibility = RubyMarshalReader(tm_path.read_bytes()).parse()

    player = save.get("player", {}) if isinstance(save, dict) else {}
    storage = save.get("storage_system", save.get("storage", {})) if isinstance(save, dict) else {}
    global_metadata = save.get("global_metadata", {}) if isinstance(save, dict) else {}
    random_moves = ivar(global_metadata, "random_moves", {}) if isinstance(global_metadata, RubyObject) else {}
    party = []
    if isinstance(player, RubyObject):
        for idx, pkmn in enumerate(ivar(player, "party", []) or []):
            data = pokemon_to_dict(pkmn, "Equipo", idx + 1)
            if data:
                party.append(enrich_pokemon(data, species_ref, forms_ref, moves_ref, abilities_ref, tm_compatibility, random_moves))

    boxes = []
    if isinstance(storage, RubyObject):
        for box_idx, box in enumerate(ivar(storage, "boxes", []) or []):
            box_name = ivar(box, "name", f"Caja {box_idx + 1}")
            mons = []
            for slot_idx, pkmn in enumerate(ivar(box, "pokemon", []) or []):
                data = pokemon_to_dict(pkmn, box_name, slot_idx + 1)
                if data:
                    mons.append(enrich_pokemon(data, species_ref, forms_ref, moves_ref, abilities_ref, tm_compatibility, random_moves))
            boxes.append({"name": box_name, "index": box_idx + 1, "pokemon": mons})

    out = {
        "save_path": str(save_path),
        "player_name": ivar(player, "name") if isinstance(player, RubyObject) else None,
        "game_context": {
            "badges": 3,
            "current_level_cap": 39,
            "access_policy": "current_level_owned_tms_owned_items",
        },
        "inventory": export_inventory(save.get("bag", {}) if isinstance(save, dict) else {}, items_ref, ivar(global_metadata, "tm_move_map", {}) if isinstance(global_metadata, RubyObject) else {}),
        "party": party,
        "boxes": boxes,
    }
    out = sanitize_text(out)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Exported {len(party)} party Pokemon and {sum(len(b['pokemon']) for b in boxes)} boxed Pokemon to {args.out}")


if __name__ == "__main__":
    main()
