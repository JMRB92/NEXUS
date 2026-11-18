NEXUS v1.02 — JUEGO DE CARTAS ESTRATÉGICO
=======================================
Fecha: 18/11/2026
Plataforma: GitHub Pages + Firebase Authentication (anónima) + Realtime Database.
Proyecto Firebase configurado: nexus-7a23a.

IMPORTANTE: PUBLICACIÓN SEGURA, SIN ROMPER LAS PARTIDAS EXISTENTES
-----------------------------------------------------------------
1. DESCARGA Y GUARDA una copia de los archivos de v1.01 y exporta la base de
   datos actual desde Firebase Console > Realtime Database > menú de datos.
2. EVITA cambiar las reglas de la base de datos mientras existan partidas v1.01
   activas. Las reglas nuevas restringen accesos que el código antiguo utilizaba.
3. PRUEBA los archivos de v1.02 en un repositorio GitHub Pages de pruebas.
   Para probar sin afectar a producción, crea también una base de datos Firebase
   de pruebas independiente, con Authentication anónima activada, y cambia allí
   firebase-config.js. Puedes usar los datos del proyecto original para publicar
   posteriormente en producción, pero NO para pruebas que modifiquen partidas reales.
4. Copia todo el contenido de este ZIP en la RAÍZ del repositorio de GitHub,
   manteniendo la carpeta assets/ y los nombres de archivo.
5. Abre Firebase Console > Realtime Database > Reglas. Usa el contenido COMPLETO
   de firebase-rules.json en el entorno de pruebas. El archivo dentro de GitHub
   NO instala las reglas; debes publicarlas en Firebase Console.
6. Comprueba dos teléfonos/navegadores distintos: crear sala, invitar, jugar,
   completar varias rondas, ganar, solicitar revancha y volver a jugar.
7. Tras probar, publica las reglas y el código en producción de forma coordinada,
   preferiblemente cuando las salas de la versión anterior hayan finalizado.

CAMBIOS DE v1.02
----------------
- 27 cartas originales conservadas, incluyendo Varek (12). Los efectos del
  resolvedor no se han cambiado, salvo el barajado uniforme de Malikor.
- Con dos jugadores, mazo de 16 cartas: se excluyen 01, 02, 12, 13, 18, 22,
  33, 42, 61, 71 y 91, en todas las rondas.
- Nuevas imágenes de portada e iconos NEXUS, favicon y manifest PWA.
- Miniaturas completas sin recorte, manteniendo su proporción.
- Sala de espera, partida, resultado y revancha con el MISMO código.
- Tras finalizar la partida, 10 minutos para pedir revancha. La PRIMERA
  solicitud inicia otros 10 minutos desde ella para los demás jugadores.
  Para empezar, el anfitrión debe estar entre los al menos dos solicitantes
  conectados. No se amplía el plazo con sucesivos clics.
- La antigüedad máxima original de 48 horas no se reinicia por revanchas.
  La limpieza física se intenta al abrir la aplicación y al acceder a una sala;
  NO existe un proceso automático en segundo plano que garantice la hora exacta.
- Los resultados se conservan SOLO en el navegador local, no en un histórico
  de resultados remoto.
- Contadores globales OCULTOS: salasCreadas +1 por sala nueva,
  partidasFinalizadas +1 por partida terminada (también revancha). Se guardan
  independientemente de las salas. Se intenta deduplicar resultados por evento.
- Hasta tres salas activas por identidad anónima y al menos 20 segundos entre
  creaciones; son límites disuasorios, no protección frente a bots avanzados.
- Transacciones con versión de estado para evitar sobrescrituras entre jugadas.
- Recuperación de identidad, detección de reconexiones y mejoras de mensajes.
- Caché PWA únicamente para los recursos de arte; el juego requiere conexión.

LIMITACIONES REALES DE SEGURIDAD Y CONSISTENCIA
----------------------------------------------
A) Seguridad PARCIAL: las reglas impiden que usuarios que no participan lean
   juegos en curso o modifiquen sus estados. Las cartas siguen dentro de
   /salas/{codigo}/juego/manos para conservar el motor del juego. Por tanto, un
   participante técnicamente avanzado PUEDE leer las manos de otros mediante
   las herramientas del navegador, y algunos estados siguen siendo manipulables.
   Protección total requiere resolver cartas y reparto en backend confiable.
B) Contadores: incremento simple y registro de eventos son dos operaciones.
   Una desconexión entre ellas puede perder un incremento. Los contadores no
   se reinician al borrar salas, pero no son infalsificables ni transacciones
   atómicas globales. Las reglas permiten +1; un cliente malicioso podría
   ejecutar múltiples incrementos. No deben utilizarse para premios o pagos.
C) Limpieza oportunista: las salas finalizadas o caducadas pueden seguir
   físicamente almacenadas hasta que un cliente ejecute una limpieza válida.
   Sin tareas programadas no es posible garantizar borrado puntual.
D) Identidad anónima: al borrar almacenamiento local, cookies o credenciales,
   el usuario puede perder su identidad, su historial local y su acceso a la
   sala; la recuperación por nombre requiere aprobación del anfitrión.
E) Para instalar la PWA y Firebase en producción, sirve HTTPS (GitHub Pages).
   El motor utiliza crypto.getRandomValues y requiere contexto seguro.
F) Las reglas Firebase incluidas se han REVISADO ESTÁTICAMENTE pero NO han sido
   verificadas contra Firebase Emulator ni una base de datos Firebase real en
   este entorno. Prueba permisos y flujos reales antes de reemplazar las reglas
   de producción, ya que incluso un pequeño error bloquearía las partidas.

COMPROBACIONES LOCALES REALIZADAS
--------------------------------
- Sintaxis JavaScript y JSON: correcta.
- 8 pruebas de utilidades: mazos, barajado, nombres, 48h y revancha: correctas.
- Pruebas en Chromium con Firebase simulado: inicio, sala, contador, partida
  de 2 jugadores, robo, jugada, cambio de turno, victoria, revancha, doble
  intento de robo, partida de 3 jugadores con 27 cartas, anfitrión en revancha.
- 27 imágenes originales: copia exacta y sin modificaciones.
- Efectos de cartas: comparación automatizada con v1.01, sin cambios salvo
  el barajado. NO equivale a prueba en vivo de todas las interacciones.
- Las pruebas de concurrencia se han realizado con un simulador Firebase, no
  mediante varios dispositivos conectados a Firebase real.

ARCHIVOS
--------
index.html           Entrada de la aplicación
app.js               Motor de juego e interfaz
nexus-core.js        Utilidades y lógica pura de mazo/caducidad
styles.css           Estilos
firebase-config.js   Configuración pública de Firebase
firebase-rules.json  Reglas PROPUESTAS para publicar manualmente en Firebase
assets/cartas/       27 imágenes originales de cartas
assets/nexus-logo.jpg, icon-*.png, favicon.png  Nueva identidad visual
manifest.webmanifest, service-worker.js       Instalación PWA / caché de arte

Sin cuentas personales, sin servidor propio, sin compras ni pagos incorporados.
