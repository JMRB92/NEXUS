# NEXUS v1.03 — Solución a «Permiso denegado»

**Importante:** GitHub Pages publica HTML/CSS/JS, pero **no** modifica los permisos de Firebase. Aunque `firebase-rules.json` se vea en GitHub, las reglas efectivas son las que hayas publicado en la consola de Firebase. No he tenido acceso al panel de reglas activo de tu proyecto y por tanto no puedo confirmar su contenido actual ni cambiarlas desde este ZIP.

## 1. Comprueba el proyecto y activa la autenticación anónima

1. Abre https://console.firebase.google.com/ y selecciona **nexus-7a23a**.
2. Ve a **Compilación / Build → Authentication → Sign-in method / Método de acceso**.
3. Comprueba que **Anónimo** esté **habilitado**. Si no, actívalo y guarda.
4. La aplicación usa la base de datos **Realtime Database**, región **europe-west1**: `https://nexus-7a23a-default-rtdb.europe-west1.firebasedatabase.app`. No confundas las reglas de Firestore con las de Realtime Database.

## 2. Publica las reglas nuevas en Realtime Database

1. En Firebase Console, abre **Realtime Database → Reglas / Rules**.
2. Copia primero el texto de tus reglas actuales como respaldo.
3. Abre `firebase-rules.json` de este ZIP, copia **todo** su contenido y pégalo en el editor de Realtime Database.
4. Pulsa **Publicar** (Publish) y verifica que no haya errores de sintaxis o validación.
5. Si ves reglas temporales de prueba con `now < ...`, puede que hayan caducado: son una causa frecuente de `PERMISSION_DENIED`.
6. No uses `.read: true` / `.write: true` generales para intentar arreglarlo; expondrías las partidas.

## 3. Actualiza la web

Sube los archivos de la raíz del ZIP al repositorio `JMRB92/NEXUS`, reemplazando los anteriores. Mantén la misma estructura (`index.html`, `app.js`, `assets/`...). El HTML fuerza la nueva versión JS `?v=103`. Recarga la web.

## 4. Diagnóstico según el mensaje

- **«PERMISO DENEGADO en transacción en /salas/CÓDIGO»**: las reglas activas deniegan la lectura o escritura que necesita la transacción de creación. Revisa el paso 2. La aplicación no puede saltarse ese permiso.
- **«La autenticación anónima está desactivada»** o `auth/operation-not-allowed`: revisa el paso 1.
- **«Espera 20 segundos»**: se creó correctamente otra sala hace menos de 20 segundos desde ese navegador.
- **«Máximo de tres salas activas»**: ese usuario ya tiene tres salas abiertas; libera o deja caducar alguna.
- **Aviso en la consola de `usuarioSalas`, `limiteUsuarios` o `estadisticasGlobales`**: no impide crear la sala en v1.03, pero algunas funciones auxiliares no están disponibles hasta publicar las reglas adecuadas.

## 5. Qué cambia de verdad en v1.03

- `createRoom()` ya **no** escribe en `usuarioSalas` ni en `limiteUsuarios` antes de crear la sala.
- Las restricciones de número de salas son comprobaciones de solo lectura y no bloquean el acceso por fallos de permiso auxiliares.
- Primero se reserva la sala con transacción atómica en `/salas/CÓDIGO` y se muestra al anfitrión. **Después**, se intentan actualizar índices y estadísticas.
- El plazo local de 20 segundos se guarda únicamente después de que la sala se haya creado. No penaliza intentos fallidos por permisos.
- Ante permiso denegado, la pantalla de creación indica la ruta que falló.
- La portada, el CSS, el logotipo y el motor de las 27 cartas **no cambian**.

## 6. Límites conocidos

- La base de datos REAL y sus reglas no se han probado ni modificado desde este entorno. Las pruebas de la app utilizan Firebase simulado.
- Con Firebase Spark y la lógica del juego en el navegador, los permisos por participante mejoran el acceso pero **no garantizan** antifraude total.
- Los contadores elegidos como incrementos simples pueden perderse en determinadas desconexiones y no son infalsificables.
- El límite de tres salas no se puede hacer ineludible con este modelo de cliente anónimo.
- La eliminación automática sigue siendo oportunista al abrir/consultar la aplicación, no una tarea programada de servidor.

**Verificación mínima tras publicar reglas:** crea una sala, entra desde otro navegador con otro usuario anónimo, inicia partida, roba/juega, finaliza y solicita revancha. Si falla, anota el mensaje exacto que aparece junto a «Crear sala»; ahora incluye la operación rechazada.
