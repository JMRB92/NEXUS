# NEXUS v1.02.1 — Corrección de la portada y la creación de salas

**Fecha:** 18 de noviembre de 2026.

## Causas localizadas

1. **Portada:** `styles.css` tenía una regla `@media(min-width:720px)` que aplicaba `float:right` al logotipo. Por eso quedaban palabras del titular a un lado y debajo de la imagen.
2. **Crear sala:** v1.02 consultaba obligatoriamente `limiteUsuarios/{uid}` y `usuarioSalas/{uid}` ANTES de escribir `/salas/{codigo}`. Las reglas de Firebase de v1.01 solo autorizaban `/salas` y `/estadisticas/{uid}`; al actualizar solo los archivos de GitHub, esas dos operaciones fallaban por `permission_denied` y se cancelaba la creación.
3. **Navegador con almacenamiento restringido:** el arranque leía `localStorage` fuera de un bloque `try`, pudiendo interrumpir la inicialización de la interfaz.
4. **Errores poco visibles:** al fallar la creación, el error solo aparecía en el mensaje general debajo de todas las pantallas.

## Cambios aplicados

- Portada en composición vertical, logo encima del eslogan y botones, sin `float` en escritorio ni móvil.
- Alternativa de compatibilidad para las reglas antiguas: ante un rechazo **específico** en `limiteUsuarios` o `usuarioSalas`, utiliza un límite de frecuencia local y, cuando las reglas lo permiten, consulta las salas propias para respetar las tres salas simultáneas. No altera las reglas de las cartas.
- Mensaje de error junto a «Crear sala» cuando falla la propia escritura de sala.
- Acceso a `localStorage` tolerante a bloqueos y cacheo de archivos actualizado (`?v=1021`).
- Ninguna modificación del catálogo, las 27 imágenes, el resolvedor de efectos, el reparto ni la lógica de turnos y revanchas respecto de v1.02.

## Pruebas realizadas

| Comprobación | Estado | Método |
|---|---|---|
| Imagen encima del texto, móvil 390 px | **Correcto** | Chromium y CSS real con recursos embebidos |
| Imagen encima del texto, escritorio 1024 px | **Correcto** | Chromium y CSS real con recursos embebidos |
| Crear sala con `permission_denied` en rutas nuevas | **Correcto** | Firebase simulado con reglas equivalentes de v1.01 |
| Arranque y crear sala cuando `localStorage` no está disponible | **Correcto** | Chromium con acceso a almacenamiento bloqueado |
| Crear sala con rutas nuevas disponibles | **Correcto** | Simulador anterior sin rechazos |
| Juego de dos jugadores, cartas, victoria y revancha | **Correcto** | Prueba de regresión con Firebase simulado |
| 8 pruebas de utilidades | **Correcto** | Node.js |
| 27 imágenes originales y efectos conservados | **Correcto** | Comparación automática con v1.01 |
| Acceso con Firebase real y reglas publicadas | **No comprobado** | Requiere integración en Firebase |

## Publicación y límites

1. Sustituye los archivos de la versión fallida por los del ZIP. Copia la **raíz del ZIP** al repositorio de GitHub Pages; no subas una carpeta contenedora adicional.
2. Con reglas de v1.01, debería poderse crear una sala mediante el modo de compatibilidad. **No** se actualizarán los contadores globales ni se activarán los nuevos permisos de seguridad hasta publicar `firebase-rules.json` en la **consola de Firebase** (subir el archivo a GitHub no sirve).
3. Para publicar las reglas, haz antes una copia de seguridad de Realtime Database y comprueba la integración con dos navegadores. Estas reglas siguen ofreciendo seguridad parcial y no han sido verificadas en Firebase Emulator ni en producción.
4. No confundir «pruebas superadas con Firebase simulado» con «funcionamiento verificado en Firebase real».
5. El límite local y por consulta es disuasorio y más débil que el índice del servidor; un usuario con herramientas técnicas puede evitarlo.
