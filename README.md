# Collibot4fun

Bot de WhatsApp modular (Node.js + TypeScript) que centraliza control de acceso, apertura de puerta, snapshots de cámara y auditoría avanzada. Sólo responde a usuarios registrados y aplica blacklist automático tras intentos no autorizados.

## ✨ Funcionalidades Principales
- Autenticación por número: sólo contesta a números en tabla `usuarios` activos (rol admin o normal).
- Intentos y Blacklist: registra intentos de números desconocidos; tras 10 intentos se añade a `blacklist` (silenciado).
- Menú principal interactivo (usuarios normales y admin).
- Apertura de puerta vía API HTTP externa (timeout y validación del resultado).
- Captura de snapshots desde dos flujos RTSP (visitas / peatones) usando `ffmpeg`.
- Gestión de usuarios (crear, actualizar nombre/rol/teléfono/activo, eliminar) mediante flujo conversacional paso a paso (sólo admin).
- Búsqueda interactiva de usuarios por nombre o teléfono parcial.
- Gestión de blacklist (listar y remover) menú admin.
- Auditoría completa: registra mensajes entrantes/salientes y acciones administrativas/sistema.
- Menú de auditoría persistente con: paginación, filtros dinámicos, límites configurables (últimos 10/20/50/100), exportación CSV y contexto persistente (`AuditContext`).
- Comando `reset` para limpiar estados conversacionales de un admin.
- Notificación de arranque a números configurados.
- Centralización estricta de variables de entorno en `src/config.ts` (único lugar que toca `process.env`).
- Docker multi-stage listo para producción (Chromium + ffmpeg en Alpine).

## 📁 Arquitectura
```
src/
	app.ts                # Bootstrap del bot (DB + WhatsApp client + handlers)
	config.ts             # Carga y validación de variables de entorno (ENV)
	controllers/
		messageController.ts # Lógica de menús, flujos interactivos y control de estados
	database/
		index.ts            # Inicialización TypeORM (SQLite)
		models.ts           # Entidades: Usuario, Auditoria, Blacklist, Attempt, AuditContext
	services/
		userService.ts      # CRUD usuarios, blacklist, búsqueda, auditoría de cambios
		doorService.ts      # Apertura de puerta vía API externa (axios)
		cameraService.ts    # Snapshot RTSP con ffmpeg
		auditService.ts     # Helper crear registros de auditoría
	utils/
		concurrency.ts      # (Reservado para utilidades de concurrencia)
```

## 🗄️ Entidades Clave
- `Usuario`: nombre, telefono (único), rol (`admin|normal`), activo.
- `Attempt`: intentos fallidos por número desconocido (para umbral de blacklist).
- `Blacklist`: números silenciados (no responden ni generan más intentos).
- `Auditoria`: registro de cada acción/mensaje (actor, tipo, detalle).
- `AuditContext`: estado persistente de paginación/filtro del menú de auditoría por admin.

## 🔐 Seguridad & Reglas
- Mensajes de números no registrados: se incrementa Attempt y se ignora (sin revelar lógica interna).
- Al llegar al umbral (10 intentos): número pasa a blacklist y deja de generar intentos.
- Admin ve opciones ampliadas (menús: usuarios, auditoría, blacklist).
- Estados conversacionales por admin se aíslan (no bloquean a otros admin).
- Comando `reset` limpia cualquier flujo en curso (crear/editar/borrar/buscar usuarios, auditoría, blacklist).

## 🧩 Menú Principal (Usuario)
1. Abrir puerta
2. Snapshot cámara visitas
3. Snapshot cámara peatones
4. Estado (eco + rol + hora)
5. (Admin) Gestión de usuarios
6. (Admin) Exportar / acciones varias (según evolución)
7. (Admin) Menú Auditoría
8. (Admin) Menú Blacklist

El menú se muestra tras acciones relevantes y cuando el usuario envía un número válido fuera de sub-menús.

## 👤 Flujo Gestión de Usuarios (Admin)
Accedido vía opción 5:
1. Crear usuario (pasos: nombre → teléfono → rol → confirmación)
2. Listar usuarios
3. Actualizar (seleccionar usuario → elegir atributo: nombre, rol, toggle activo, teléfono → confirmar)
4. Eliminar (confirmación explícita "SI")
5. Buscar (ingresar fragmento nombre o teléfono → mostrar coincidencias)
0. Salir

La búsqueda admite coincidencias parciales (case-insensitive). Edición de teléfono valida unicidad.

## 📄 Menú Auditoría (Admin, opción 7)
Opciones típicas:
1/2/3/4: Ajustar límite de registros (10/20/50/100)
5: Página anterior
6: Página siguiente
7: Establecer filtro (palabra/frase, aplica `LIKE` en contenido relevante)
8: Limpiar filtro
9: Exportar CSV (envía archivo con conjunto filtrado/paginado)
0: Salir

Contexto persiste (offset, filter, limit) en DB y expira tras inactividad prolongada.

## 🚫 Menú Blacklist (Admin, opción 8)
- Lista entradas con índice.
- Para eliminar: enviar índice mostrado.
- `0` salir.

## 🧪 Auditoría de Acciones
Se auditan (tipo y detalle):
- Mensajes entrantes (usuario / desconocido)
- Respuestas del bot
- Creación / actualización / eliminación de usuarios
- Cambios de blacklist
- Exportaciones de auditoría y cambios de filtro/paginación
- Apertura de puerta y snapshots

## ⚙️ Variables de Entorno (bot.env)
| Nombre | Obligatoria | Descripción |
| ------ | ----------- | ----------- |
| `DB_PATH` | Sí | Ruta fichero SQLite (ej: `./db.sqlite`) |
| `WHATSAPP_AUTH_DIR` | Sí | Carpeta persistente de sesión whatsapp-web.js |
| `CHROMIUM_PATH` | Sí | Ruta ejecutable Chromium/Chrome en el host/imagen |
| `BOT_NAME` | Sí | Nombre mostrado en mensajes de estado / arranque |
| `DOOR_API_BASE` | Sí | URL base API puerta (sin barra final) |
| `RTSP_VISITS_URL` | Sí | URL RTSP cámara de visitas |
| `RTSP_PEDESTRIAN_URL` | Sí | URL RTSP cámara de peatones |
| `STARTUP_NOTIFY_NUMBERS` | No | Lista coma-separada de números a notificar al iniciar |
| `NODE_ENV` | No | `development` / `production` (default: development) |

Ejemplo `bot.env` (usa credenciales ficticias):
```
DB_PATH=./db.sqlite
WHATSAPP_AUTH_DIR=.wwebjs_auth
CHROMIUM_PATH=/usr/bin/chromium-browser
BOT_NAME=ColliBot
DOOR_API_BASE=
RTSP_VISITS_URL=
RTSP_PEDESTRIAN_URL=
STARTUP_NOTIFY_NUMBERS=549XXXXXXXXXX,549XXXXXXXXXX
```

## 🛠️ Desarrollo Local
1. Clonar repositorio
2. Crear `bot.env` con variables anteriores
3. Instalar dependencias: `npm ci`
4. Ejecutar en modo dev: `npm start` (usa `ts-node`)
5. Escanear el QR en consola (primera vez) con el número autorizado admin inicial (definir manualmente en DB o bootstrap si implementado)

Compilar a JS: `npm run build` (genera `dist/`).

## 🐳 Docker
Construir y ejecutar (usa `docker-compose.yml`):
```
docker compose up -d --build
```
Persistencia:
- Volumen `db_data` → SQLite
- Volumen `wa_session` → sesiones WhatsApp

Variables se inyectan vía `env_file: bot.env` (asegúrate de copiar sólo variables necesarias y NO subir el archivo a un repo público con secretos/URLs sensibles).

### Problema común: SQLITE_CANTOPEN
Si ves repetidamente `SQLITE_CANTOPEN: unable to open database file` el usuario dentro del contenedor (`app`, UID 1000) no tiene permisos de escritura sobre el volumen montado en `/data` (y/o `/session`). Con volúmenes *named* nuevos Docker los crea root:root.

Solución rápida (ajustar ownership de volúmenes existentes):
```bash
docker stop collibot || true
docker rm collibot || true
docker run --rm \
	-v collibot4fun_db_data:/data \
	-v collibot4fun_wa_session:/session \
	alpine sh -c "chown -R 1000:1000 /data /session && ls -ld /data /session"

docker run -d --name collibot \
	--restart unless-stopped \
	--env-file bot.env \
	-v collibot4fun_db_data:/data \
	-v collibot4fun_wa_session:/session \
	rafavg77/collibot4fun:1.0.0
```
Comprueba logs:
```bash
docker logs -f collibot
```
Verificación de escritura:
```bash
docker exec -it collibot sh -c "touch /data/_test && ls -l /data/_test && rm /data/_test"
```

Alternativas:
- Ejecutar como root (`user: root` en compose) — menos seguro.
- Script de entrypoint que haga `chown` (requiere ejecutar como root y luego bajar privilegios).

### Reconstruir imagen local
```bash
docker build -t rafavg77/collibot4fun:1.0.0 -t rafavg77/collibot4fun:latest .
```

### Publicar en Docker Hub (nueva versión)
1. Inicia sesión:
```bash
docker login
```
2. Construye con nueva versión (ej: 1.0.1):
```bash
docker build -t rafavg77/collibot4fun:1.0.1 -t rafavg77/collibot4fun:latest .
```
3. Push:
```bash
docker push rafavg77/collibot4fun:1.0.1
docker push rafavg77/collibot4fun:latest
```
4. (Opcional) Tag git:
```bash
git tag -a v1.0.1 -m "Release 1.0.1"
git push origin v1.0.1
```

### Multi-arquitectura (amd64 + arm64) con buildx
```bash
docker buildx create --name multi --use || true
docker buildx build --platform linux/amd64,linux/arm64 \
	-t rafavg77/collibot4fun:1.0.1 \
	-t rafavg77/collibot4fun:latest \
	--push .
```

### Actualizar contenedor en servidor
```bash
docker pull rafavg77/collibot4fun:1.0.1
docker stop collibot || true
docker rm collibot || true
docker run -d --name collibot \
	--restart unless-stopped \
	--env-file bot.env \
	-v collibot4fun_db_data:/data \
	-v collibot4fun_wa_session:/session \
	rafavg77/collibot4fun:1.0.1
```

### Ver logs y QR
```bash
docker logs -f collibot
```
Si necesitas re-escanear (sesión inválida), elimina volumen de sesión:
```bash
docker stop collibot
docker rm collibot
docker volume rm collibot4fun_wa_session   # cuidado: pierdes sesión anterior
```

## 📤 Exportación CSV Auditoría
En menú auditoría opción 9 genera un CSV con columnas clave (timestamp, actor, tipo, detalle). Se envía como documento al chat admin.

## 🔒 Seguridad / Publicación
- No publiques `bot.env` ni `.env`. Usa `bot.env.example` como plantilla.
- Revisa que `db.sqlite`, `.wwebjs_auth/` y `/session` estén ignorados (ya lo están en `.gitignore` y `.dockerignore`).
- No hornees secretos en la imagen Docker; injéctalos en tiempo de despliegue con `--env-file` o variables.
- Antes de hacer push público, busca patrones sensibles (rtsp://user:pass@, tokens, claves) y cámbialos a variables de entorno.

## 🧹 Limpieza de Estados
`reset` (mensaje plano) elimina cualquier flujo activo para el admin que lo envía (menus usuario/auditoría/blacklist/búsqueda/edición).

## 🚀 Roadmap / Mejores Futuras
- Migrar a PostgreSQL (desactivar `synchronize` y usar migraciones).
- Optimizar filtro de auditoría a nivel SQL más específico / índices.
- Control de tasa (rate limiting) adicional por usuario.
- Almacenamiento de snapshots en disco o S3 con links temporales.
- Panel web ligero para ver auditorías y administrar usuarios.

## 📝 Notas de Diseño
- Se centraliza acceso a entorno en `config.ts` para minimizar errores y permitir validación temprana.
- Estados conversacionales en memoria (Maps/Sets) → simplicidad; escalado horizontal requerirá capa externa (Redis) o sticky sessions.
- `synchronize: true` facilita desarrollo; en producción considerar migraciones.
- Blacklist evita spam y reduce ruido en logs (no audita más tras inclusión).

## ⚖️ Licencia
Uso interno / educativo (definir licencia formal si se publica públicamente).

---
Para dudas o extensiones, crear un issue o extender servicios siguiendo el patrón existente.
