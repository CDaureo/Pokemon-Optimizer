const STORAGE_KEY = "anil_optimizer_save_json";
const save = loadSaveData();
const gameContext = save.game_context || { badges: 3, current_level_cap: 39 };

function loadSaveData() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (error) {
    console.warn("No se pudo cargar la partida guardada en el navegador.", error);
  }
  if (window.ANIL_SAVE_DATA?.party?.length || window.ANIL_SAVE_DATA?.boxes?.length) {
    return window.ANIL_SAVE_DATA;
  }
  return {
    player_name: "Sin partida",
    party: [],
    boxes: [],
    inventory: [],
    game_context: { badges: 3, current_level_cap: 39 }
  };
}

const typeChart = {
  NORMAL: { weak: ["FIGHTING"], resist: [], immune: ["GHOST"] },
  FIRE: { weak: ["WATER", "GROUND", "ROCK"], resist: ["FIRE", "GRASS", "ICE", "BUG", "STEEL", "FAIRY"], immune: [] },
  WATER: { weak: ["ELECTRIC", "GRASS"], resist: ["FIRE", "WATER", "ICE", "STEEL"], immune: [] },
  ELECTRIC: { weak: ["GROUND"], resist: ["ELECTRIC", "FLYING", "STEEL"], immune: [] },
  GRASS: { weak: ["FIRE", "ICE", "POISON", "FLYING", "BUG"], resist: ["WATER", "ELECTRIC", "GRASS", "GROUND"], immune: [] },
  ICE: { weak: ["FIRE", "FIGHTING", "ROCK", "STEEL"], resist: ["ICE"], immune: [] },
  FIGHTING: { weak: ["FLYING", "PSYCHIC", "FAIRY"], resist: ["BUG", "ROCK", "DARK"], immune: [] },
  POISON: { weak: ["GROUND", "PSYCHIC"], resist: ["GRASS", "FIGHTING", "POISON", "BUG", "FAIRY"], immune: [] },
  GROUND: { weak: ["WATER", "GRASS", "ICE"], resist: ["POISON", "ROCK"], immune: ["ELECTRIC"] },
  FLYING: { weak: ["ELECTRIC", "ICE", "ROCK"], resist: ["GRASS", "FIGHTING", "BUG"], immune: ["GROUND"] },
  PSYCHIC: { weak: ["BUG", "GHOST", "DARK"], resist: ["FIGHTING", "PSYCHIC"], immune: [] },
  BUG: { weak: ["FIRE", "FLYING", "ROCK"], resist: ["GRASS", "FIGHTING", "GROUND"], immune: [] },
  ROCK: { weak: ["WATER", "GRASS", "FIGHTING", "GROUND", "STEEL"], resist: ["NORMAL", "FIRE", "POISON", "FLYING"], immune: [] },
  GHOST: { weak: ["GHOST", "DARK"], resist: ["POISON", "BUG"], immune: ["NORMAL", "FIGHTING"] },
  DRAGON: { weak: ["ICE", "DRAGON", "FAIRY"], resist: ["FIRE", "WATER", "ELECTRIC", "GRASS"], immune: [] },
  DARK: { weak: ["FIGHTING", "BUG", "FAIRY"], resist: ["GHOST", "DARK"], immune: ["PSYCHIC"] },
  STEEL: { weak: ["FIRE", "FIGHTING", "GROUND"], resist: ["NORMAL", "GRASS", "ICE", "FLYING", "PSYCHIC", "BUG", "ROCK", "DRAGON", "STEEL", "FAIRY"], immune: ["POISON"] },
  FAIRY: { weak: ["POISON", "STEEL"], resist: ["FIGHTING", "BUG", "DARK"], immune: ["DRAGON"] }
};

const state = {
  locked: new Set(),
  excluded: new Set(),
  moveSort: {},
  optimizationReport: null
};

const inventory = (save.inventory || []).map((item) => ({
  ...item,
  scoreText: `${item.name} x${item.quantity}`
}));
const ownedTmMoves = new Set(inventory.filter((item) => item.move && String(item.id).startsWith("TM")).map((item) => item.move));
const itemLookup = new Map(inventory.map((item) => [item.id, item]));

const allPokemon = [
  ...save.party.map((p) => ({ ...p, source: "Equipo" })),
  ...save.boxes.flatMap((box) => box.pokemon.map((p) => ({ ...p, source: box.name })))
].map((p, index) => normalizePokemon(p, index));

function normalizePokemon(p, index) {
  const id = `${p.box}-${p.slot}-${p.species}-${index}`;
  const isDead = String(p.box).toUpperCase().includes("MUERTOS");
  const damagingMoves = p.moves.filter((m) => m.power > 0);
  const coverage = [...new Set(damagingMoves.map((m) => m.type).filter(Boolean))];
  const normalized = { ...p, id, isDead, coverage };
  normalized.available_moves = availableMovesFor(normalized);
  normalized.best_moves = bestMovesFor(normalized);
  normalized.potential_coverage = [...new Set(normalized.best_moves.filter((m) => m.power > 0).map((m) => m.type).filter(Boolean))];
  normalized.current_item = currentHeldItem(normalized);
  normalized.current_item_value = normalized.current_item ? itemValue(normalized.current_item, { ...normalized, best_moves: normalized.moves }) : 0;
  normalized.best_items = bestItemsFor(normalized);
  normalized.best_item_value = normalized.best_items[0]?.item_value || 0;
  normalized.current_score = scorePokemon(normalized, "current");
  normalized.potential_score = scorePokemon(normalized, "potential");
  return {
    ...normalized,
    score: normalized.potential_score
  };
}

function currentHeldItem(p) {
  if (!p.item) return null;
  const known = itemLookup.get(p.item);
  if (known) return { ...known, quantity: 1 };
  return {
    id: p.item,
    name: prettifyId(p.item),
    description: "",
    quantity: 1,
    pocket: 1,
    flags: []
  };
}

function prettifyId(id) {
  return String(id || "")
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function scorePokemon(p, mode = "potential") {
  const atk = p.attack || 0;
  const spa = p.spatk || 0;
  const hp = p.totalhp || p.hp || 0;
  const bulk = hp + (p.defense || 0) + (p.spdef || 0);
  const speed = p.speed || 0;
  const statScore = Math.max(atk, spa) * 1.15 + bulk * 0.42 + speed * 0.9;
  const moves = mode === "current" ? p.moves : (p.best_moves || p.moves);
  const moveScore = moves.reduce((sum, move) => sum + moveValue(move, p), 0);
  const moveCoverage = new Set(moves.filter((move) => move.power > 0).map((move) => move.type).filter(Boolean));
  const itemScore = mode === "current" ? (p.current_item_value || 0) : (p.best_item_value || 0);
  const coverageScore = offensiveCoverageScore([...moveCoverage]) * 4;
  const repetitionPenalty = moveRepetitionPenalty(moves) * 10;
  return Math.round(statScore + moveScore + abilityValue(p) + moveCoverage.size * 12 + coverageScore + itemScore * 0.75 - repetitionPenalty);
}

function moveValue(move, p) {
  const atk = p.attack || 0;
  const spa = p.spatk || 0;
  const utility = moveUtility(move, p);
  if (move.power > 0) {
    const stab = stabMultiplier(move, p);
    const acc = move.accuracy > 0 ? move.accuracy / 100 : 1;
    const bestStat = Math.max(1, atk, spa);
    const statFit = move.category === "Physical" ? atk / bestStat : move.category === "Special" ? spa / bestStat : 1;
    const priority = utility.tags.includes("Prioridad") ? 20 : 0;
    const reliability = move.accuracy >= 100 || move.accuracy === 0 ? 8 : 0;
    const coverage = p.types.includes(move.type) ? 0 : 10;
    return move.power * acc * stab * (0.8 + statFit * 0.32) + priority + reliability + coverage + utility.score;
  }
  return utility.score;
}

function stabMultiplier(move, p) {
  return move.power > 0 && p.types.includes(move.type) ? 1.5 : 1;
}

function effectivePower(move, p) {
  if (!move.power) return 0;
  return Math.round(move.power * stabMultiplier(move, p));
}

function bestMovesFor(p) {
  const allMoves = p.available_moves?.length ? p.available_moves : p.moves;
  const unique = new Map();
  for (const move of [...p.moves, ...allMoves]) unique.set(move.id, move);
  const sorted = [...unique.values()]
    .map((move) => ({ ...move, set_value: moveValue(move, p) + moveSupportValue(move) }))
    .sort((a, b) => b.set_value - a.set_value);
  const chosen = [];
  const damagingTypes = new Set();
  for (const move of sorted) {
    if (chosen.length >= 4) break;
    const duplicateAttack = move.power > 0 && damagingTypes.has(move.type) && chosen.some((m) => m.power > 0 && m.category === move.category);
    const worseThanSameRole = move.power > 0 && chosen.some((m) => sameAttackRole(m, move) && (m.set_value || moveValue(m, p)) > (move.set_value || moveValue(move, p)) * 1.15);
    if (duplicateAttack || worseThanSameRole) {
      continue;
    }
    chosen.push(move);
    if (move.power > 0) damagingTypes.add(move.type);
  }
  for (const move of sorted) {
    if (chosen.length >= 4) break;
    if (!chosen.some((m) => m.id === move.id)) chosen.push(move);
  }
  return chosen;
}

function sameAttackRole(a, b) {
  return a.power > 0 && b.power > 0 && a.type === b.type && a.category === b.category;
}

function moveSupportValue(move) {
  return moveSupports(move).reduce((sum, support) => sum + support.value * 0.45, 0);
}

function moveUtility(move, p) {
  const fc = move.function_code || "";
  const text = `${move.name || ""} ${move.description || ""}`.toLowerCase();
  const tags = [];
  let score = 0;
  const add = (tag, value) => {
    tags.push(tag);
    score += value;
  };

  if (/RaiseUser.*(Atk|Attack|SpAtk|Spd|Speed)|RaiseUserMainStats|ShellSmash|NoRetreat|Quiver|DragonDance|SwordsDance|NastyPlot|BulkUp|CalmMind|Coil|ShiftGear/i.test(fc) || /danza|aumenta|sube|rompecoraza|motivacion|maquinacion|afilagarras/.test(text)) {
    const offensiveFit = Math.max(p.attack || 0, p.spatk || 0, p.speed || 0) / 10;
    add("Setup", 44 + Math.min(28, offensiveFit));
  }
  if (/RaiseUser.*(Def|SpDef)|DefenseCurl|Stockpile/i.test(fc) || /defensa|def\. esp|escudo|fortalece/.test(text)) {
    add("Boost defensivo", 30 + Math.min(20, ((p.defense || 0) + (p.spdef || 0)) / 18));
  }
  if (/HealUser|Recover|Roost|Synthesis|SlackOff|Heal.*HP|Wish/i.test(fc) || /recupera|cura|restaura.*ps|mitad de los ps|auxilio/.test(text)) {
    add("Recovery", 52 + Math.min(20, (p.totalhp || 0) / 8));
  }
  if (/SwitchOutUser|Teleport|BatonPass/i.test(fc) || /vuelve|cambiar|relevo|da paso/.test(text)) {
    add("Pivot", 42 + Math.min(18, (p.speed || 0) / 10));
  }
  if (/Add.*ToFoeSide|StickyWeb|StealthRock|Spikes|ToxicSpikes/i.test(fc) || /trampa rocas|puas|red viscosa|campo rival/.test(text)) {
    add("Hazard", 58);
  }
  if (/Remove.*Hazards|RapidSpin|Defog/i.test(fc) || /despeja|giro rapido|elimina.*trampas/.test(text)) {
    add("Control hazards", 46);
  }
  if (/Burn|Paralyze|Poison|Sleep|Confuse|Flinch|Attract|Yawn/i.test(fc) || /quema|paraliza|envenena|duerme|confunde|amedrenta|bostezo/.test(text)) {
    add("Estado", 28 + (move.power > 0 ? 8 : 18));
  }
  if (/LowerTarget.*(Atk|Attack|SpAtk|Speed|Def|SpDef)|PartingShot|NobleRoar|Charm|ScaryFace|EerieImpulse/i.test(fc) || /reduce|baja|disminuye/.test(text)) {
    add("Debuff", 24 + (move.power > 0 ? 10 : 0));
  }
  if (/Protect|KingsShield|BanefulBunker|SpikyShield|Obstruct|Detect/i.test(fc) || /protege|bunker|escudo real|bloquea/.test(text)) {
    add("Proteccion", 38);
  }
  if (/Weather|Terrain|Room|Gravity|Tailwind|Screens|Reflect|LightScreen|AuroraVeil/i.test(fc) || /clima|campo|pantalla|reflejo|viento afin|espacio raro|gravedad/.test(text)) {
    add("Soporte campo", 34);
  }
  if (/Type|ChangeUserType|Soak|TrickOrTreat|ForestCurse|Camouflage/i.test(fc) || /cambia.*tipo|tipo del usuario|anade el tipo|empapa/.test(text)) {
    add("Control de tipo", 26);
  }
  if (/Trap|Bind|MeanLook|Block/i.test(fc) || /no podra huir|atrapa|bloquea el cambio/.test(text)) {
    add("Trap", 24);
  }
  if (/Priority|First/i.test(fc) || /prioridad|velocidad extrema|acua jet|sombra vil|puño bala|canto helado|subito|escarmuza/.test(text)) {
    add("Prioridad", 30);
  }
  if (/Multi|HitTwo|HitThree|HitTen|TwoToFive/i.test(fc)) {
    add("Multi-hit", 14);
  }
  if (/Recoil|Crash|UserFaints|Recharge|FailsIf|TwoTurn|Charge/i.test(fc) || /retroceso|se debilita|recarga|primer turno|dos turnos/.test(text)) {
    add("Riesgo", -22);
  }
  if (move.accuracy && move.accuracy < 80) add("Impreciso", -12);
  if (!tags.length && move.power <= 0) add("Nicho", 8);
  return { score, tags };
}

function availableMovesFor(p) {
  const currentIds = new Set(p.moves.map((move) => move.id));
  const moves = [...p.moves.map((move) => ({ ...move, source: "current", accessible: true }))];
  const addMove = (move, sourceOverride) => {
    if (!move || currentIds.has(move.id)) return;
    currentIds.add(move.id);
    moves.push({ ...move, source: sourceOverride || move.source, accessible: true });
  };
  for (const move of p.learnable_moves?.level || []) {
    if ((move.level ?? 0) <= (p.level || gameContext.current_level_cap || 39)) addMove(move, "random_level");
  }
  for (const move of p.learnable_moves?.random_tm || []) {
    if (ownedTmMoves.has(move.id)) addMove(move, "owned_tm");
  }
  return moves;
}

function statusMoveValue(move) {
  const text = `${move.name} ${move.description}`.toLowerCase();
  if (/danza|aumenta mucho|aumenta el ataque|aumenta su ataque|velocidad/.test(text)) return 42;
  if (/cura|recupera|drenadoras|sintesis|respiro/.test(text)) return 34;
  if (/protege|bunker|escudo|trampa|puas|rocas/.test(text)) return 28;
  if (/duerme|paraliza|quema|envenena|confunde|retroceder/.test(text)) return 22;
  return 10;
}

function abilityValue(p) {
  const text = `${p.ability_name || ""} ${p.ability_description || ""}`.toLowerCase();
  let value = 18;
  if (/sube|aumenta|potencia|duplica|prioridad|critico|afortunado|nado rapido|clorofila|impetu arena/.test(text)) value += 28;
  if (/cura|regenera|inmune|evita|absorbe|no recibe|protege/.test(text)) value += 22;
  if (/huir|fuga/.test(text)) value -= 12;
  return value;
}

function bestItemsFor(p) {
  const candidates = [...inventory];
  if (p.current_item) candidates.push({ ...p.current_item, quantity: 1, equipped: true });
  const unique = new Map();
  for (const item of candidates) {
    if (!item?.id) continue;
    const previous = unique.get(item.id);
    if (!previous || item.equipped) unique.set(item.id, item);
  }
  return [...unique.values()]
    .map((item) => ({ ...item, item_value: itemValue(item, p) }))
    .filter((item) => item.item_value > 0)
    .sort((a, b) => b.item_value - a.item_value || a.name.localeCompare(b.name))
    .slice(0, 8);
}

function itemValue(item, p) {
  if (!isHeldCandidate(item)) return 0;
  const id = item.id || "";
  const name = (item.name || "").toLowerCase();
  const desc = (item.description || "").toLowerCase();
  const moveTypes = new Set((p.best_moves || p.moves).filter((m) => m.power > 0).map((m) => m.type));
  const physical = (p.best_moves || p.moves).filter((m) => m.category === "Physical").length;
  const special = (p.best_moves || p.moves).filter((m) => m.category === "Special").length;
  const status = (p.best_moves || p.moves).filter((m) => !m.power).length;
  let score = 0;

  if (id.endsWith("PLATE")) {
    const plateType = plateTypeFor(id);
    if (plateType && (p.types.includes(plateType) || moveTypes.has(plateType))) score += 58;
    if (plateType && moveTypes.has(plateType)) score += 18;
  }
  if (id === "LIGHTBALL" && p.species === "PIKACHU") score += 120;
  if (id === "PUNCHINGGLOVE" && hasPunchingMove(p)) score += 64;
  if (id === "LOADEDDICE" && (p.best_moves || p.moves).some((move) => moveUtility(move, p).tags.includes("Multi-hit"))) score += 58;
  if (id === "FOCUSSASH" && (p.totalhp || p.hp || 0) < 120) score += 45;
  if (id === "LEFTOVERS") score += 40 + Math.min(20, (p.totalhp || 0) / 12);
  if (id === "ROCKYHELMET" && ((p.defense || 0) + (p.totalhp || 0)) > 170) score += 42;
  if (id === "BRIGHTPOWDER") score += 24 + Math.min(18, p.speed / 8);
  if (id === "SAFETYGOGGLES") score += 28;
  if (id === "MIRRORHERB") score += 24 + status * 3;
  if (id === "WHITEHERB" && (hasMove(p, "ROMPECORAZA") || hasMove(p, "SHELLSMASH") || hasText(p, "baja"))) score += 78;
  if (id === "MENTALHERB" && status >= 2) score += 45;
  if (id === "MISTYSEED" || id === "ELECTRICSEED") score += 18 + ((p.defense || 0) + (p.spdef || 0)) / 20;
  if (id === "IRONBALL" && (p.speed || 0) < 70) score += 18;
  if (id === "STICKYBARB") score += 8;
  if (id === "SOOTHEBELL" || id.includes("INCENSE")) score -= 20;
  if (id.includes("BERRY")) score += berryValue(item, p);
  if (/potencia|aumenta|sube|mejora|refuerza/.test(desc)) score += 24;
  if (/tipo/.test(desc) && [...moveTypes, ...p.types].some((type) => desc.includes(type.toLowerCase()))) score += 16;
  if (/cura|restaura|debilita|reduce/.test(desc) && item.pocket === 5) score += 18;

  if (physical >= 3 && /fuerte|puño|garra|cinta|banda/.test(name + " " + desc)) score += 16;
  if (special >= 3 && /mental|sabio|gafas|especial/.test(name + " " + desc)) score += 16;
  return Math.round(score);
}

function hasPunchingMove(p) {
  return (p.best_moves || p.moves).some((move) => /punch|puño|pu[ñn]o/i.test(`${move.id || ""} ${move.name || ""} ${move.flags?.join(" ") || ""}`));
}

function isHeldCandidate(item) {
  if (!item || item.quantity <= 0) return false;
  if (item.move || String(item.id).startsWith("TM")) return false;
  if ((item.flags || []).includes("KeyItem")) return false;
  if (item.pocket === 3 || item.pocket === 4 || item.pocket === 8) return false;
  if (item.field_use === "Direct" && item.pocket !== 5) return false;
  if (item.battle_use && item.pocket !== 5) return false;
  return true;
}

function plateTypeFor(id) {
  return {
    FISTPLATE: "FIGHTING",
    MINDPLATE: "PSYCHIC",
    DRACOPLATE: "DRAGON",
    DREADPLATE: "DARK",
    FLAMEPLATE: "FIRE",
    SPLASHPLATE: "WATER",
    ZAPPLATE: "ELECTRIC",
    MEADOWPLATE: "GRASS",
    ICICLEPLATE: "ICE",
    TOXICPLATE: "POISON",
    EARTHPLATE: "GROUND",
    SKYPLATE: "FLYING",
    INSECTPLATE: "BUG",
    STONEPLATE: "ROCK",
    SPOOKYPLATE: "GHOST",
    IRONPLATE: "STEEL",
    PIXIEPLATE: "FAIRY"
  }[id];
}

function berryValue(item, p) {
  const text = `${item.name} ${item.description}`.toLowerCase();
  let score = 10;
  if (/cura|restaura|ps|estado|confusion|quemadura|paralisis|veneno|sueño|congelacion/.test(text)) score += 22;
  if ((p.totalhp || 0) > 120) score += 8;
  return score;
}

function hasMove(p, id) {
  return (p.best_moves || p.moves).some((move) => move.id === id || move.name.toUpperCase().replaceAll(" ", "") === id);
}

function hasText(p, text) {
  return (p.best_moves || p.moves).some((move) => `${move.name} ${move.description}`.toLowerCase().includes(text));
}

const synergyLabels = {
  rain: "lluvia",
  sun: "sol",
  sand: "arena",
  snow: "nieve/granizo",
  tailwind: "viento afin",
  trickroom: "espacio raro",
  screens: "pantallas",
  electricterrain: "campo electrico",
  grassyterrain: "campo de hierba",
  mistyterrain: "campo de niebla",
  psychicterrain: "campo psiquico"
};

function teamSynergies(team, mode = "set") {
  const providers = [];
  const needs = [];
  for (const p of team) {
    for (const support of pokemonSupports(p, mode)) providers.push({ pokemon: p, ...support });
    for (const need of abilityNeeds(p)) needs.push({ pokemon: p, ...need });
  }
  const synergies = [];
  for (const need of needs) {
    const matches = providers
      .filter((provider) => provider.key === need.key && provider.pokemon.id !== need.pokemon.id)
      .sort((a, b) => b.value - a.value || b.pokemon.score - a.pokemon.score);
    if (!matches.length) continue;
    const provider = matches[0];
    synergies.push({
      key: need.key,
      value: need.value + provider.value,
      receiver: need.pokemon,
      provider: provider.pokemon,
      reason: `${need.pokemon.display_name} aprovecha ${synergyLabels[need.key]} por ${need.ability}; ${provider.pokemon.display_name} lo activa con ${provider.source}.`
    });
  }
  return synergies
    .sort((a, b) => b.value - a.value)
    .filter((item, index, arr) => arr.findIndex((other) => other.receiver.id === item.receiver.id && other.key === item.key) === index);
}

function pokemonSupports(p, mode = "set") {
  const supports = [];
  const abilityText = abilityTextFor(p);
  const add = (key, source, value) => supports.push({ key, source, value });

  if (/drizzle|llovizna/.test(abilityText)) add("rain", p.ability_name, 58);
  if (/drought|sequia|sequía/.test(abilityText)) add("sun", p.ability_name, 58);
  if (/sandstream|chorro arena/.test(abilityText)) add("sand", p.ability_name, 58);
  if (/snowwarning|nevada|granizo/.test(abilityText)) add("snow", p.ability_name, 50);

  const moves = mode === "possible" ? (p.available_moves || p.best_moves || p.moves) : (p.best_moves || p.moves);
  for (const move of moves) {
    for (const support of moveSupports(move)) add(support.key, move.name, support.value);
  }
  return supports;
}

function bestPossibleSynergyBonus(p, pool) {
  return comboInfoFor(p, pool).bonus;
}

function comboInfoFor(p, pool) {
  const team = pool.filter((other) => other.id !== p.id);
  const asReceiver = teamSynergies([p, ...team], "possible")
    .filter((item) => item.receiver.id === p.id)
    .slice(0, 2);
  const asProvider = teamSynergies([p, ...team], "possible")
    .filter((item) => item.provider.id === p.id)
    .slice(0, 2);
  const receiverBonus = asReceiver.reduce((sum, item) => sum + item.value, 0);
  const providerBonus = asProvider.reduce((sum, item) => sum + item.value * 0.7, 0);
  return {
    bonus: Math.round(Math.min(180, receiverBonus + providerBonus)),
    pairs: [
      ...asReceiver.map((item) => ({ ...item, role: "receiver" })),
      ...asProvider.map((item) => ({ ...item, role: "provider" }))
    ].sort((a, b) => b.value - a.value)
  };
}

function moveSupports(move) {
  const fc = move.function_code || "";
  const moveKey = `${move.id || ""} ${move.name || ""}`.toLowerCase();
  const supports = [];
  const add = (key, value) => supports.push({ key, value });
  if (/StartRainWeather/i.test(fc) || /raindance|danza lluvia/.test(moveKey)) add("rain", 44);
  if (/StartSunWeather/i.test(fc) || /sunnyday|dia soleado|día soleado/.test(moveKey)) add("sun", 44);
  if (/StartSandstormWeather/i.test(fc) || /sandstorm|tormenta arena/.test(moveKey)) add("sand", 44);
  if (/StartHailWeather|StartSnowWeather/i.test(fc) || /hail|snowscape|granizo|paisaje nevado/.test(moveKey)) add("snow", 38);
  if (/Tailwind/i.test(fc) || /tailwind|viento afin/.test(moveKey)) add("tailwind", 34);
  if (/TrickRoom/i.test(fc) || /trickroom|espacio raro/.test(moveKey)) add("trickroom", 34);
  if (/Reflect|LightScreen|AuroraVeil|Screens/i.test(fc) || /reflect|lightscreen|auroraveil|reflejo|pantalla luz|velo aurora/.test(moveKey)) add("screens", 30);
  if (/ElectricTerrain/i.test(fc) || /electricterrain|campo electrico/.test(moveKey)) add("electricterrain", 28);
  if (/GrassyTerrain/i.test(fc) || /grassyterrain|campo de hierba/.test(moveKey)) add("grassyterrain", 28);
  if (/MistyTerrain/i.test(fc) || /mistyterrain|campo de niebla/.test(moveKey)) add("mistyterrain", 28);
  if (/PsychicTerrain/i.test(fc) || /psychicterrain|campo psiquico/.test(moveKey)) add("psychicterrain", 28);
  return supports;
}

function abilityNeeds(p) {
  const text = abilityTextFor(p);
  const needs = [];
  const add = (key, ability, value) => needs.push({ key, ability, value });
  if (/swiftswim|nado rapido/.test(text)) add("rain", p.ability_name, 64);
  if (/hydration|hidratacion|raindish|cura lluvia|plato lluvia|dryskin|piel seca/.test(text)) add("rain", p.ability_name, 42);
  if (/chlorophyll|clorofila|solarpower|poder solar|leafguard|defensa hoja|harvest|cosecha/.test(text)) add("sun", p.ability_name, 56);
  if (/sandrush|impetu arena|ímpetu arena|sandforce|poder arena|sandveil|velo arena/.test(text)) add("sand", p.ability_name, 54);
  if (/slushrush|quitanieves|icebody|gelido|gélido|snowcloak|manto niveo|manto níveo/.test(text)) add("snow", p.ability_name, 48);
  if (/surgesurfer|cola surf|cola surfista/.test(text)) add("electricterrain", p.ability_name, 50);
  if (/grasspelt|manto frondoso/.test(text)) add("grassyterrain", p.ability_name, 38);
  if (/telepathy|sincronia|sincronía/.test(text) && (p.speed || 0) < 70) add("trickroom", p.ability_name, 14);
  if ((p.speed || 0) >= 95 && Math.max(p.attack || 0, p.spatk || 0) >= 90) add("tailwind", "atacante rapido", 18);
  if ((p.defense || 0) + (p.spdef || 0) < 130) add("screens", "aguanta mejor con pantallas", 12);
  return needs;
}

function abilityTextFor(p) {
  return `${p.ability || ""} ${p.ability_name || ""} ${p.ability_description || ""}`.toLowerCase();
}

function teamMoveTypes(team) {
  return team.flatMap((p) => (p.best_moves || p.moves).filter((move) => move.power > 0).map((move) => move.type).filter(Boolean));
}

function offensiveCoverageScore(moveTypes) {
  const covered = new Set();
  for (const attackType of moveTypes) {
    for (const defendType of Object.keys(typeChart)) {
      if (typeEffectiveness(attackType, defendType) > 1) covered.add(defendType);
    }
  }
  return covered.size;
}

function typeEffectiveness(attackType, defendType) {
  const chart = typeChart[defendType] || {};
  if ((chart.immune || []).includes(attackType)) return 0;
  if ((chart.weak || []).includes(attackType)) return 2;
  if ((chart.resist || []).includes(attackType)) return 0.5;
  return 1;
}

function moveRepetitionPenalty(moves) {
  const counts = {};
  for (const move of moves) {
    if (!move.power || !move.type) continue;
    counts[move.type] = (counts[move.type] || 0) + 1;
  }
  return Object.values(counts).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function teamMoveRepetitionPenalty(team) {
  const counts = {};
  for (const type of teamMoveTypes(team)) counts[type] = (counts[type] || 0) + 1;
  return Object.values(counts).reduce((sum, count) => sum + Math.max(0, count - 2) * 18, 0);
}

function teamScore(team) {
  const base = team.reduce((sum, p) => sum + p.score, 0);
  const moveTypes = new Set(team.flatMap((p) => p.potential_coverage || p.coverage));
  const speciesTypes = new Set(team.flatMap((p) => p.types));
  const weaknesses = weaknessCounts(team);
  const stackedWeaknessPenalty = Object.values(weaknesses).reduce((sum, count) => sum + Math.max(0, count - 2) * 35, 0);
  const speedBonus = team.filter((p) => (p.speed || 0) >= 100).length * 20;
  const priorityBonus = team.filter((p) => p.best_moves.some((m) => /extrema|subito|acua jet|puño bala|canto helado/i.test(m.name))).length * 12;
  const synergyBonus = teamSynergies(team, "possible").slice(0, 6).reduce((sum, item) => sum + item.value, 0);
  const offensiveCoverage = offensiveCoverageScore(teamMoveTypes(team));
  const repetitionPenalty = teamMoveRepetitionPenalty(team);
  return Math.round(base + moveTypes.size * 20 + offensiveCoverage * 22 + speciesTypes.size * 14 + speedBonus + priorityBonus + synergyBonus - stackedWeaknessPenalty - repetitionPenalty);
}

function weaknessCounts(team) {
  const counts = {};
  for (const p of team) {
    const multipliers = {};
    for (const type of p.types) {
      const chart = typeChart[type] || {};
      for (const weak of chart.weak || []) multipliers[weak] = (multipliers[weak] || 1) * 2;
      for (const resist of chart.resist || []) multipliers[resist] = (multipliers[resist] || 1) * 0.5;
      for (const immune of chart.immune || []) multipliers[immune] = 0;
    }
    for (const [type, mult] of Object.entries(multipliers)) {
      if (mult > 1) counts[type] = (counts[type] || 0) + 1;
    }
  }
  return counts;
}

function optimizeTeam(pool) {
  const locked = [...state.locked].map((id) => allPokemon.find((p) => p.id === id)).filter((p) => p && !p.isDead);
  let beams = [{ team: locked, score: teamScore(locked) }];
  const candidates = pool.filter((p) => !p.isDead && !state.locked.has(p.id)).sort((a, b) => (b.combo_score || b.score) - (a.combo_score || a.score)).slice(0, 34);
  while (beams[0].team.length < 6) {
    const next = [];
    for (const beam of beams) {
      for (const p of candidates) {
        if (beam.team.some((x) => x.id === p.id)) continue;
        const team = [...beam.team, p];
        next.push({ team, score: teamScore(team) });
      }
    }
    beams = next.sort((a, b) => b.score - a.score).slice(0, 140);
    if (!beams.length) break;
  }
  return beams[0]?.team || locked;
}

function currentPool() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const includeDead = document.getElementById("includeDead").checked;
  const onlyAvailable = document.getElementById("onlyAvailable").checked;
  return allPokemon
    .filter((p) => includeDead || !p.isDead)
    .filter((p) => !onlyAvailable || !state.excluded.has(p.id))
    .filter((p) => !query || pokemonSearchText(p).includes(query))
    .sort((a, b) => b.score - a.score);
}

function pokemonSearchText(p) {
  return [
    p.display_name,
    p.species_name,
    p.ability_name,
    p.box,
    ...p.types,
    ...p.moves.map((m) => `${m.name} ${m.type}`),
    ...(p.learnable_moves?.all || []).map((m) => `${m.name} ${m.type}`)
  ].join(" ").toLowerCase();
}

function spritePath(p) {
  return `sprites/${p.species}.png`;
}

function renderPokemonCard(p, compact = false) {
  const moveChips = p.moves.map((m) => `<span class="chip ${m.power > 0 ? "damage" : ""}" title="${m.name}">${m.name}</span>`).join("");
  const typeChips = p.types.map((t) => typeChip(t)).join("");
  const actionButtons = compact ? "" : `
    <div class="small-actions">
      ${p.isDead ? "" : `<button class="${state.locked.has(p.id) ? "active" : ""}" data-action="lock" data-id="${p.id}">Fijar</button>`}
      <button class="${state.excluded.has(p.id) ? "active" : ""}" data-action="exclude" data-id="${p.id}">Excluir</button>
    </div>`;
  const bestMoveHint = p.best_moves?.length ? `<span class="chip">Set: ${p.best_moves.map((m) => m.name).join(" / ")}</span>` : "";
  const bestItemHint = p.best_items?.length ? `<span class="chip">Obj: ${p.best_items[0].name}</span>` : "";
  const changeClass = teamChangeClass(p, compact);
  const changeBadge = changeClass ? `<span class="change-badge">${changeLabel(changeClass)}</span>` : "";
  const scoreDelta = (p.potential_score || p.score || 0) - (p.current_score || 0);
  return `
    <article class="${compact ? "team-card" : "poke-card"} ${p.isDead ? "dead" : ""} ${changeClass}" data-pokemon-id="${p.id}">
      <img class="sprite" src="${spritePath(p)}" alt="${p.species_name}" loading="lazy" />
      <div class="poke-main">
        <div class="name-row">
          <span class="poke-name">${p.display_name}</span>
          <span class="score">Opt ${p.potential_score}</span>
        </div>
        <div class="score-row">
          <span>Actual ${p.current_score}</span>
          <span>Opt ${p.potential_score}</span>
          <span>Combo ${p.combo_score || p.potential_score}</span>
          <span>Mejora ${scoreDelta >= 0 ? "+" : ""}${scoreDelta}</span>
        </div>
        ${comboShort(p)}
        ${changeBadge}
        <div class="meta">
          <span>${p.species_name}</span>
          <span>Nv. ${p.level}</span>
          <span>${p.box} #${p.slot}</span>
        </div>
        <div class="types">${typeChips}</div>
        <div class="ability">${p.ability_name}</div>
        <div class="moves">${moveChips}</div>
        ${compact ? "" : `<div class="moves">${bestMoveHint}${bestItemHint}</div>`}
        ${actionButtons}
      </div>
    </article>`;
}

function render() {
  for (const id of [...state.locked]) {
    const p = allPokemon.find((item) => item.id === id);
    if (p?.isDead) state.locked.delete(id);
  }
  const pool = currentPool();
  if (!allPokemon.length) {
    document.getElementById("summary").textContent = "Ejecuta abrir_optimizador.bat o carga un JSON de partida.";
    document.getElementById("rosterCount").textContent = "0 mostrados";
    document.getElementById("roster").innerHTML = `<p class="empty-state">No hay partida cargada.</p>`;
    document.getElementById("recommendedTeam").innerHTML = `<p class="empty-state">Sin datos para optimizar.</p>`;
    document.getElementById("teamScore").textContent = "";
    document.getElementById("teamNotes").innerHTML = "";
    return;
  }
  const team = optimizeTeam(pool);
  document.getElementById("summary").textContent = `${save.player_name} · ${save.party.length} en equipo · ${save.boxes.reduce((n, b) => n + b.pokemon.length, 0)} en PC · ${gameContext.badges} medallas · nivel actual`;
  document.getElementById("rosterCount").textContent = `${pool.length} mostrados`;
  document.getElementById("roster").innerHTML = renderRoster(pool);
  document.getElementById("recommendedTeam").innerHTML = team.map((p) => renderPokemonCard(p, true)).join("");
  document.getElementById("teamScore").textContent = `${teamScore(team)} pts`;
  document.getElementById("teamNotes").innerHTML = `${renderOptimizationReport()}${renderTeamNotes(team)}`;
}

function typeChip(type) {
  const normalized = String(type || "?").toUpperCase();
  return `<span class="type-chip type-${normalized}">${normalized}</span>`;
}

function renderRoster(pool) {
  const flatList = document.getElementById("flatList")?.checked;
  if (!flatList) return renderRosterSections(pool);
  const mons = pool.slice().sort((a, b) => b.score - a.score || b.level - a.level || a.display_name.localeCompare(b.display_name));
  return `<section class="box-section">
    <div class="box-head">
      <h3>Lista unica por valor</h3>
      <span>${mons.length} Pokemon · mayor valor primero</span>
    </div>
    <div class="box-grid flat-grid">${mons.map((p) => renderPokemonCard(p)).join("")}</div>
  </section>`;
}

function handleOptimizeClick() {
  const team = optimizeTeam(currentPool());
  state.optimizationReport = buildOptimizationReport(team);
  render();
  document.querySelector(".recommendation")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function currentPartyPokemon() {
  return allPokemon.filter((p) => p.source === "Equipo" || p.box === "Equipo");
}

function buildOptimizationReport(team) {
  const current = currentPartyPokemon();
  const currentIds = new Set(current.map((p) => p.id));
  const teamIds = new Set(team.map((p) => p.id));
  return {
    entering: team.filter((p) => !currentIds.has(p.id)),
    leaving: current.filter((p) => !teamIds.has(p.id)),
    staying: team.filter((p) => currentIds.has(p.id)),
    previousScore: teamScore(current),
    optimizedScore: teamScore(team)
  };
}

function teamChangeClass(p, compact) {
  const report = state.optimizationReport;
  if (!report) return "";
  if (report.entering.some((x) => x.id === p.id)) return "change-enter";
  if (report.leaving.some((x) => x.id === p.id)) return "change-leave";
  if (compact && report.staying.some((x) => x.id === p.id)) return "change-stay";
  return "";
}

function changeLabel(changeClass) {
  return {
    "change-enter": "Entra al equipo",
    "change-leave": "Sale del equipo",
    "change-stay": "Se queda"
  }[changeClass] || "";
}

function comboShort(p) {
  const pair = p.combo_pairs?.[0];
  if (!pair) return "";
  const other = pair.role === "receiver" ? pair.provider : pair.receiver;
  const action = pair.role === "receiver" ? "con" : "ayuda a";
  return `<button type="button" class="combo-hint" data-pokemon-id="${other.id}">Combo ${action} ${other.display_name}: ${synergyLabels[pair.key]}</button>`;
}

function comboDetails(p) {
  const pairs = p.combo_pairs || [];
  if (!pairs.length) return `<div class="combo-panel"><strong>Combo</strong><p>No he encontrado una pareja clara para subir su valor.</p></div>`;
  return `
    <div class="combo-panel">
      <div class="change-title">
        <strong>Combo</strong>
        <span>+${p.combo_bonus || 0} pts</span>
      </div>
      ${pairs.slice(0, 5).map((pair) => {
        const other = pair.role === "receiver" ? pair.provider : pair.receiver;
        const label = pair.role === "receiver" ? `Recibe ayuda de ${other.display_name}` : `Ayuda a ${other.display_name}`;
        return `<button type="button" class="synergy-card" data-pokemon-id="${other.id}">
          <span>${label}</span>
          <small>${pair.reason}</small>
        </button>`;
      }).join("")}
    </div>`;
}

function renderOptimizationReport() {
  const report = state.optimizationReport;
  if (!report) return "";
  const delta = report.optimizedScore - report.previousScore;
  return `
    <div class="team-change-panel">
      <div class="change-title">
        <strong>Cambios al optimizar</strong>
        <span>${report.previousScore} -> ${report.optimizedScore} pts (${delta >= 0 ? "+" : ""}${delta})</span>
      </div>
      ${changeGroup("Entran", report.entering)}
      ${changeGroup("Salen", report.leaving)}
      ${changeGroup("Se quedan", report.staying)}
    </div>`;
}

function changeGroup(title, mons) {
  return `
    <div class="change-group">
      <span>${title}</span>
      <div>${mons.length ? mons.map((p) => `<button type="button" class="change-pill" data-pokemon-id="${p.id}">${p.display_name} <small>Nv. ${p.level}</small></button>`).join("") : "<em>Ninguno</em>"}</div>
    </div>`;
}

function renderRosterSections(pool) {
  const order = ["Equipo", ...save.boxes.map((box) => box.name)];
  const grouped = new Map();
  for (const p of pool) {
    const key = p.box || p.source || "Otros";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  }
  const keys = [...grouped.keys()].sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.localeCompare(b);
  });
  return keys.map((key) => {
    const mons = grouped.get(key);
    return `<section class="box-section">
      <div class="box-head">
        <h3>${key}</h3>
        <span>${mons.length} Pokemon</span>
      </div>
      <div class="box-grid">${mons.map((p) => renderPokemonCard(p)).join("")}</div>
    </section>`;
  }).join("");
}

function renderTeamNotes(team) {
  const coverage = [...new Set(team.flatMap((p) => p.potential_coverage || p.coverage))];
  const weaknesses = Object.entries(weaknessCounts(team)).sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= 2);
  const fast = team.filter((p) => (p.speed || 0) >= 100).map((p) => p.display_name);
  const setSynergies = teamSynergies(team, "set").slice(0, 5);
  const possibleSynergies = teamSynergies(team, "possible")
    .filter((item) => !setSynergies.some((setItem) => setItem.provider.id === item.provider.id && setItem.receiver.id === item.receiver.id && setItem.key === item.key))
    .slice(0, 5);
  const offensiveCovered = offensiveCoverageScore(teamMoveTypes(team));
  const repeatedAttackTypes = repeatedTeamAttackTypes(team);
  return `
    <p><strong>Cobertura:</strong> ${coverage.join(", ") || "sin ataques ofensivos detectados"}.</p>
    <p><strong>Tipos a los que pega fuerte:</strong> ${offensiveCovered}/${Object.keys(typeChart).length} cubiertos supereficaz.</p>
    <p><strong>Ataques repetidos:</strong> ${repeatedAttackTypes.length ? repeatedAttackTypes.map(([type, n]) => `${type} x${n}`).join(", ") : "bien repartidos"}.</p>
    <p><strong>Velocidad:</strong> ${fast.length ? fast.join(", ") : "faltan pivots rapidos"}.</p>
    <p><strong>Debilidades repetidas:</strong> ${weaknesses.length ? weaknesses.map(([t, n]) => `${t} x${n}`).join(", ") : "ninguna grave"}.</p>
    ${synergyList("Combinaciones del set recomendado", setSynergies, "no hay una sinergia clara de clima/campo/pantallas en los sets recomendados.")}
    ${synergyList("Combinaciones posibles", possibleSynergies, "no hay una combinacion extra clara con movimientos accesibles.")}`;
}

function synergyList(title, synergies, emptyText) {
  return synergies.length ? `
    <div class="synergy-list">
      <strong>${title}</strong>
      ${synergies.map((item) => `
        <button type="button" class="synergy-card" data-pokemon-id="${item.receiver.id}">
          <span>${item.provider.display_name} -> ${item.receiver.display_name}</span>
          <small>${item.reason}</small>
        </button>`).join("")}
    </div>` : `<p><strong>${title}:</strong> ${emptyText}</p>`;
}

function repeatedTeamAttackTypes(team) {
  const counts = {};
  for (const type of teamMoveTypes(team)) counts[type] = (counts[type] || 0) + 1;
  return Object.entries(counts).filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]);
}

function showDetails(pokemonId) {
  const p = allPokemon.find((item) => item.id === pokemonId);
  if (!p) return;
  const overlay = document.getElementById("detailOverlay");
  document.getElementById("detailTitle").innerHTML = `
    <div class="detail-title">
      <img src="${spritePath(p)}" alt="${p.species_name}" />
      <div>
        <h2>${p.display_name}</h2>
        <p class="meta">${p.species_name} · Nv. ${p.level} · ${p.box} #${p.slot} · ${p.ability_name}</p>
      </div>
    </div>`;
  document.getElementById("detailBody").innerHTML = renderDetailBody(p);
  overlay.dataset.openPokemonId = pokemonId;
  overlay.hidden = false;
}

function renderDetailBody(p) {
  const statRows = pokemonStatRows(p);
  return `
    <div class="detail-body">
      <section>
        <div class="section-title"><h3>Stats</h3><p>Actual ${p.current_score} · Optimo ${p.potential_score} · Combo ${p.combo_score || p.potential_score}</p></div>
        <div class="detail-types">${p.types.map((t) => typeChip(t)).join("")}</div>
        ${comboDetails(p)}
        ${statChart(statRows)}
      </section>
      <section>
        <div class="section-title"><h3>Set recomendado</h3><p>Nivel ${p.level}, ${gameContext.badges} medallas, MTs de tu bolsa</p></div>
        <div class="recommendation-list">${p.best_moves.map((m) => moveChip(m, true, p)).join("")}</div>
      </section>
      <section>
        <div class="section-title"><h3>Objeto recomendado</h3><p>Bolsa + objeto equipado ahora</p></div>
        ${currentItemSummary(p)}
        ${itemRecommendations(p)}
      </section>
      <section>
        <div class="section-title"><h3>Movimientos actuales</h3><p>${p.moves.length} equipados</p></div>
        ${moveTable(p.moves, p, `current-${p.id}`)}
      </section>
      <section class="learnset">
        <div class="section-title"><h3>Movimientos que puede aprender ahora</h3><p>${p.available_moves?.length || 0} accesibles</p></div>
        ${learnsetGroup("Accesibles ahora", p.available_moves || [], p, `available-${p.id}`)}
      </section>
    </div>`;
}

function pokemonStatRows(p) {
  const base = (p.base_stats || []).map((value) => Number(value) || 0);
  return [
    { key: "hp", label: "PS", current: p.totalhp || p.hp || 0, base: base[0] || 0 },
    { key: "attack", label: "Ataque", current: p.attack || 0, base: base[1] || 0 },
    { key: "defense", label: "Defensa", current: p.defense || 0, base: base[2] || 0 },
    { key: "spatk", label: "At. Esp.", current: p.spatk || 0, base: base[4] || 0 },
    { key: "spdef", label: "Def. Esp.", current: p.spdef || 0, base: base[5] || 0 },
    { key: "speed", label: "Velocidad", current: p.speed || 0, base: base[3] || 0 }
  ];
}

function statChart(rows) {
  const maxCurrent = Math.max(1, ...rows.map((row) => row.current));
  const total = rows.reduce((sum, row) => sum + row.current, 0);
  const bestStat = rows.slice().sort((a, b) => b.current - a.current)[0];
  return `
    <div class="stat-panel">
      <div class="stat-summary">
        <div><span>Total actual</span><strong>${total}</strong></div>
        <div><span>Mejor stat</span><strong>${bestStat.label}</strong></div>
        <div><span>Valor</span><strong>${bestStat.current}</strong></div>
      </div>
      <div class="stat-legend">
        <span><i class="legend-current"></i>Actual</span>
        <span><i class="legend-base"></i>Base</span>
      </div>
      <div class="stat-columns">
        ${rows.map((row) => statBar(row, maxCurrent)).join("")}
      </div>
    </div>`;
}

function statBar(row, maxCurrent) {
  const currentHeight = Math.max(6, Math.round((row.current / maxCurrent) * 100));
  return `
    <div class="stat-column">
      <div class="stat-label">${row.label}</div>
      <strong class="stat-current">${row.current}</strong>
      <div class="stat-track" aria-label="${row.label}: ${row.current}">
        <span class="stat-fill current" style="height:${currentHeight}%"></span>
      </div>
      <div class="stat-base"><span>Base</span><strong>${row.base || "-"}</strong></div>
    </div>`;
}

function currentItemSummary(p) {
  const item = p.current_item;
  const name = item?.name || "Sin objeto";
  return `
    <div class="current-item">
      <span>Objeto actual</span>
      <strong>${name}</strong>
      <em>Valor ${p.current_item_value || 0}</em>
    </div>`;
}

function itemRecommendations(p) {
  const items = p.best_items || [];
  if (!items.length) return `<p class="detail-empty">No he encontrado un objeto claramente util para este Pokemon.</p>`;
  return `<div class="item-grid">${items.map((item, index) => `
    <article class="item-rec">
      <div class="name-row">
        <span class="poke-name">${index + 1}. ${item.name} ${item.equipped ? "(equipado)" : `x${item.quantity}`}</span>
        <span class="score">Valor ${item.item_value}</span>
      </div>
      <p>${item.description || item.id}</p>
    </article>`).join("")}</div>`;
}

function moveChip(move, withSource = false, pokemon = null) {
  const power = move.power > 0 ? `${move.power} ${move.category || ""}` : "Estado";
  const stab = pokemon && stabMultiplier(move, pokemon) > 1 ? ` · STAB x1.5 · real ${effectivePower(move, pokemon)}` : "";
  const source = withSource && move.source ? ` · ${sourceLabel(move.source)}${move.level !== undefined ? ` ${move.level}` : ""}` : "";
  return `<span class="chip damage">${move.name} · ${move.type || "?"} · ${power}${stab}${source}</span>`;
}

function moveTable(moves, pokemon, tableId) {
  if (!moves.length) return `<p class="detail-empty">Sin movimientos.</p>`;
  const sort = state.moveSort[tableId] || { key: "level", dir: "asc" };
  const rows = sortMoves(moves, pokemon, sort)
    .map((m) => `
      <tr class="${stabMultiplier(m, pokemon) > 1 ? "stab-row" : ""}">
        <td>${m.name}</td>
        <td>${moveRole(m, pokemon)}</td>
        <td>${m.type || "-"}</td>
        <td>${m.category || "-"}</td>
        <td>${m.power || "-"}</td>
        <td>${m.power ? effectivePower(m, pokemon) : "-"}</td>
        <td>${m.accuracy || "-"}</td>
        <td>${m.level !== undefined ? m.level : sourceLabel(m.source)}</td>
        <td>${Math.round(moveValue(m, pokemon))}</td>
      </tr>`)
    .join("");
  return `<table class="move-table">
    <thead><tr>
      ${sortableTh(tableId, "name", "Movimiento", sort)}
      ${sortableTh(tableId, "role", "Rol", sort)}
      ${sortableTh(tableId, "type", "Tipo", sort)}
      ${sortableTh(tableId, "category", "Clase", sort)}
      ${sortableTh(tableId, "power", "Pot.", sort)}
      ${sortableTh(tableId, "effective", "Pot. real", sort)}
      ${sortableTh(tableId, "accuracy", "Prec.", sort)}
      ${sortableTh(tableId, "level", "Nivel", sort)}
      ${sortableTh(tableId, "value", "Valor", sort)}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function sortableTh(tableId, key, label, sort) {
  const marker = sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  return `<th><button class="sort-button" data-sort-table="${tableId}" data-sort-key="${key}" type="button">${label}${marker}</button></th>`;
}

function sortMoves(moves, pokemon, sort) {
  const dir = sort.dir === "desc" ? -1 : 1;
  const valueFor = (move) => {
    if (sort.key === "value") return moveValue(move, pokemon);
    if (sort.key === "level") return move.level ?? 9999;
    if (sort.key === "power") return move.power || 0;
    if (sort.key === "effective") return effectivePower(move, pokemon);
    if (sort.key === "accuracy") return move.accuracy || 0;
    if (sort.key === "role") return moveRole(move, pokemon);
    return String(move[sort.key] || "").toLowerCase();
  };
  return moves.slice().sort((a, b) => {
    const av = valueFor(a);
    const bv = valueFor(b);
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir || String(a.name).localeCompare(String(b.name));
    return String(av).localeCompare(String(bv)) * dir || ((a.level ?? 9999) - (b.level ?? 9999));
  });
}

function moveRole(move, pokemon) {
  const tags = moveUtility(move, pokemon).tags.filter((tag) => tag !== "Riesgo" && tag !== "Impreciso");
  const roleTags = stabMultiplier(move, pokemon) > 1 ? ["STAB x1.5", ...tags] : tags;
  if (roleTags.length) return roleTags.slice(0, 3).join(", ");
  if (move.power > 0) return stabMultiplier(move, pokemon) > 1 ? "STAB x1.5" : "Cobertura";
  return "Nicho";
}

function learnsetGroup(title, moves, pokemon, tableId) {
  const open = title.includes("MT random") || title.includes("Por nivel");
  return `<details class="learnset-group" ${open ? "open" : ""}>
    <summary>${title} · ${moves.length}</summary>
    ${moves.length ? moveTable(moves, pokemon, tableId) : `<p class="detail-empty">No hay datos para este grupo.</p>`}
  </details>`;
}

function sourceLabel(source) {
  return {
    level: "Nivel PBS",
    current: "Actual",
    owned_tm: "MT en bolsa",
    random_level: "Nivel random",
    level_pbs_fallback: "Nivel PBS fallback",
    tutor: "Tutor/MT",
    egg: "Huevo",
    random_tm: "MT random"
  }[source] || source || "-";
}

function levelGroupTitle(p) {
  return p.learnable_moves?.level_source === "random_level" ? "Por nivel randomizado" : "Por nivel PBS fallback";
}

function initializeComboScores() {
  for (const p of allPokemon) {
    const combo = comboInfoFor(p, allPokemon);
    p.combo_pairs = combo.pairs;
    p.combo_bonus = combo.bonus;
    p.combo_score = p.potential_score + combo.bonus;
  }
}

function setDataStatus() {
  const status = document.getElementById("dataStatus");
  if (!status) return;
  const hasData = allPokemon.length > 0;
  const source = localStorage.getItem(STORAGE_KEY) ? "JSON cargado" : hasData ? "Datos exportados" : "Sin partida cargada";
  const partyCount = save.party?.length || 0;
  const boxCount = (save.boxes || []).reduce((sum, box) => sum + (box.pokemon?.length || 0), 0);
  status.textContent = hasData ? `${source} · ${save.player_name || "Jugador"} · ${partyCount} equipo · ${boxCount} PC` : `${source} · ejecuta abrir_optimizador.bat`;
}

async function handleSaveFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.party) || !Array.isArray(data.boxes)) {
      throw new Error("El JSON no tiene party/boxes.");
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    location.reload();
  } catch (error) {
    alert("No pude cargar ese JSON. Usa el save_export.json generado por el extractor de Pokemon Añil.");
    console.error(error);
  }
}

function resetLoadedData() {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

document.getElementById("searchInput").addEventListener("input", render);
document.getElementById("includeDead").addEventListener("change", render);
document.getElementById("onlyAvailable").addEventListener("change", render);
document.getElementById("flatList").addEventListener("change", render);
document.getElementById("optimizeBtn").addEventListener("click", handleOptimizeClick);
document.getElementById("saveFileInput").addEventListener("change", handleSaveFileUpload);
document.getElementById("resetDataBtn").addEventListener("click", resetLoadedData);
document.addEventListener("click", (event) => {
  const sortButton = event.target.closest("button[data-sort-table]");
  if (sortButton) {
    const tableId = sortButton.dataset.sortTable;
    const key = sortButton.dataset.sortKey;
    const previous = state.moveSort[tableId] || { key: "level", dir: "asc" };
    state.moveSort[tableId] = {
      key,
      dir: previous.key === key && previous.dir === "asc" ? "desc" : "asc"
    };
    const openId = document.getElementById("detailOverlay").dataset.openPokemonId;
    if (openId) showDetails(openId);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (button) {
    const pokemon = allPokemon.find((item) => item.id === button.dataset.id);
    if (button.dataset.action === "lock" && pokemon?.isDead) return;
    const set = button.dataset.action === "lock" ? state.locked : state.excluded;
    if (set.has(button.dataset.id)) set.delete(button.dataset.id);
    else set.add(button.dataset.id);
    render();
    return;
  }
  const card = event.target.closest("[data-pokemon-id]");
  if (card) showDetails(card.dataset.pokemonId);
});
document.getElementById("closeDetail").addEventListener("click", () => {
  document.getElementById("detailOverlay").hidden = true;
});
document.getElementById("detailOverlay").addEventListener("click", (event) => {
  if (event.target.id === "detailOverlay") event.currentTarget.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") document.getElementById("detailOverlay").hidden = true;
});

initializeComboScores();
setDataStatus();
render();
