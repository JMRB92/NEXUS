# NEXUS v1.03 — Informe de pruebas (18/11/2026)

## Causas y correcciones

- Se verificó que GitHub `JMRB92/NEXUS` contiene el código v1.02.1. Las reglas `firebase-rules.json` publicadas en GitHub **no son automáticamente las reglas activas en Firebase**.
- El código v1.02.1 trataba la gestión de límites/índices como paso previo a crear; v1.03 elimina las escrituras previas.
- Se facilita un diagnóstico preciso para el caso en que el servidor deniegue la transacción de creación.
- La consulta de salas propias por `creadorUid` está expresamente permitida en las reglas v1.03 bajo filtro de `auth.uid`.

## Pruebas locales realizadas

| Prueba | Resultado | Observaciones |
|---|---|---|
| 8 pruebas unitarias de NexusCore | PASS | 27 cartas, mazo 2 jugadores, barajado, caducidad y revanchas |
| Portada móvil / escritorio | PASS | CSS e imagen del logotipo idénticos a v1.02.1 |
| Creación con rutas auxiliares denegadas | PASS | No bloquea la sala; cuenta global puede no actualizarse |
| Creación con permisos nuevos simulados | PASS | Crea sala, inicio y fases de juego |
| Escritura de sala denegada | PASS | Se muestra `PERMISO DENEGADO en transacción en /salas/CODIGO` |
| Restablecer permiso y reintentar inmediatamente | PASS | Sin cooldown falso tras intento fallido |
| Juego de 2 jugadores, victoria y revancha | PASS | Simulado con Chromium |
| Juego de 3 jugadores y mazo completo | PASS | Simulado con Chromium |
| Sintaxis JS y formato JSON | PASS | `node --check`, JSON parse |
| Prueba en Firebase real | NO REALIZADA | No se conocen las reglas activas ni se ha desplegado en tu proyecto |

## Límites de esta validación

Un mock de Firebase no ejecuta realmente el motor de reglas del servidor. Es imprescindible publicar las reglas compatibles en Realtime Database y completar una partida desde dos dispositivos antes de considerar la versión validada en producción. No se ha realizado ninguna modificación de los datos o permisos reales de Firebase.
