# Optimizador Pokemon Añil

Esta carpeta contiene la app web.

La app no trae una partida de ejemplo. Necesita exportar una partida real o cargar un JSON.

## Modo automatico

Haz doble click en:

```text
DOBLE_CLICK_AQUI.cmd
```

El lanzador busca la partida en `%APPDATA%\Pokemon Anil`, exporta los datos, actualiza `app-data.js` y abre `index.html`.

Si existe `Partida 1.rxdata`, usa esa. Si no existe, usa la partida `.rxdata` modificada mas recientemente.

No ejecutes `auto_export_and_open.ps1` directamente. Windows puede bloquearlo por politica de ejecucion. El archivo `.cmd` ya lo ejecuta con permisos temporales correctos.

## Modo manual

Tambien puedes abrir `index.html`, pulsar `Cargar JSON de partida` y elegir un JSON exportado con el extractor.

## Notas

- El optimizador no usa Pokemon muertos al optimizar.
- Los movimientos recomendados se limitan a lo accesible ahora: movimientos actuales, niveles ya alcanzados y MTs de la bolsa compatibles.
- El valor `Combo` explica sinergias posibles con otros Pokemon, como lluvia + Nado Rapido.
