# Optimizador Pokemon Añil

Esta carpeta contiene la app web.

## Modo automatico

Haz doble click en:

```text
abrir_optimizador.bat
```

El lanzador busca la partida en `%APPDATA%\Pokemon Anil`, exporta los datos, actualiza `app-data.js` y abre `index.html`.

Si existe `Partida 1.rxdata`, usa esa. Si no existe, usa la partida `.rxdata` modificada mas recientemente.

## Modo manual

Tambien puedes abrir `index.html`, pulsar `Cargar JSON de partida` y elegir un JSON exportado con el extractor.

## Notas

- El optimizador no usa Pokemon muertos al optimizar.
- Los movimientos recomendados se limitan a lo accesible ahora: movimientos actuales, niveles ya alcanzados y MTs de la bolsa compatibles.
- El valor `Combo` explica sinergias posibles con otros Pokemon, como lluvia + Nado Rapido.
