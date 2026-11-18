# NEXUS v1.02 — Informe de validación local

**Fecha:** 18 de noviembre de 2026. **Estado:** compilación local preparada para pruebas de integración Firebase. **No publicado en producción.**

| Comprobación | Resultado | Alcance |
|---|---|---|
| Sintaxis de `app.js`, `nexus-core.js`, `service-worker.js` | APROBADA | `node --check` |
| JSON de reglas y manifest | APROBADA | Análisis de JSON, no compilación de reglas en Firebase |
| Identificadores originales | APROBADA | 27 cartas, imágenes iguales byte a byte |
| Mazo de 2 jugadores | APROBADA | 16 cartas exactas; 11 excluidas |
| Mazo de 3 jugadores | APROBADA | 27 cartas distintas; reparto y carta quemada |
| Efectos de cartas | CONSERVADOS | Comparación de código con v1.01; ejecución exhaustiva pendiente |
| Barajado | APROBADA | Fisher–Yates con rechazo para evitar sesgo |
| Caducidad y revanchas | APROBADA | Pruebas unitarias de 48h y ventanas de 10 minutos |
| Crear sala y sumar contador | APROBADA | Navegador con Firebase simulado |
| Robar, jugar, pasar turno | APROBADA | Navegador con Firebase simulado |
| Dos robos simultáneos | APROBADA | Una transacción confirmada, una rechazada (simulador) |
| Victoria real y contador final | APROBADA | Navegador con Firebase simulado |
| Revancha con mismo código | APROBADA | Nuevo juego, sin contar nueva sala |
| Revancha sin anfitrión solicitante | APROBADA | Se impide iniciar una sala sin su creador |
| Persistencia de resultado | APROBADA | Almacenamiento local del navegador |
| Interfaz móvil | REVISADA | Chromium 390×844, con recursos locales parcialmente simulados |
| Reglas en Firebase real o Emulator | **PENDIENTE** | No se ha efectuado despliegue a la base real |
| Multijugador físico entre dispositivos | **PENDIENTE** | El simulador no valida redes ni reglas reales |
| Protección total frente a trampas | **NO GARANTIZADA** | Motor de cartas sigue ejecutándose en cliente |
| Estadísticas exactamente una vez | **NO GARANTIZADAS** | Incrementos simples decididos para Spark |

## Prueba obligatoria antes de sustituir v1.01

Hacer una copia de seguridad de Firebase, publicar el paquete y las reglas en un **entorno de pruebas separado**, jugar al menos una partida real de 2 y otra de 3 jugadores en varios dispositivos y verificar la consola de Firebase. Cambiar reglas de producción sin completar esta prueba podría interrumpir partidas activas.
