# Agenda personal

Agenda instalable en español con calendario perpetuo, actividades, diario, notificaciones mientras la app está abierta y visor local de fotos y videos.

## Funciones

- Calendario mensual navegable sin límite de año, actividades recurrentes y marcas de completado.
- Diario por fecha con guardado automático y botón **Guardar nota**.
- SQLite local en IndexedDB, con exportación e importación de respaldos.
- Acceso mediante passkeys/WebAuthn y sincronización entre dispositivos con sesión autenticada.
- PWA instalable en Android y iPhone. El calendario y los datos locales funcionan sin conexión; la sincronización requiere internet.
- Galería local: muestra solo los archivos o carpetas seleccionados; no sube fotos o videos.

## Passkeys, privacidad y sincronización

El inicio con Google se retiró. En un teléfono compatible, el sistema puede verificar una passkey con huella, rostro, PIN o el método de desbloqueo configurado. La app no recibe ni almacena datos biométricos. Para usar otro dispositivo, inicia sesión con una passkey disponible/sincronizada por el sistema de credenciales o usa el flujo de passkey entre dispositivos del navegador; después puedes registrar una passkey adicional en ese dispositivo.

El navegador crea y firma los retos; el backend valida las firmas, el origen, el dominio de la app y la verificación del usuario. Las sesiones usan cookies `HttpOnly`, `Secure` y `SameSite=Strict`. El servidor guarda el respaldo SQLite en un volumen persistente de Railway. La conexión viaja por HTTPS; el contenido del respaldo no tiene cifrado de extremo a extremo ni cifrado adicional de aplicación en reposo. La sincronización usa revisión optimista: si otra copia cambió mientras el dispositivo estaba desconectado, la app ofrece recibir la copia de nube o conservar la local. Antes de reemplazar una copia, descarga un respaldo SQLite local.

GitHub Pages por sí solo no puede validar passkeys. El backend y la app se sirven desde el mismo dominio de Railway porque WebAuthn requiere que el sitio y su RP ID coincidan. GitHub conserva el código y activa el despliegue de Pages; la URL de Railway es la dirección para usar passkeys y sincronización.

## Fotos, videos y almacenamiento

La galería no sube ni guarda medios, por lo que la agenda no consume espacio de nube para fotos. La app no puede consultar el espacio libre del teléfono ni recorrer automáticamente la SD; el selector del sistema solo entrega los archivos o la carpeta que el usuario elige.

## Despliegue en Railway

El servicio usa Node.js y SQLite en un volumen montado en `/data`. Configuración requerida:

- `DB_PATH=/data/agenda.sqlite`
- `APP_ORIGIN=https://<dominio-del-servicio>` (sin barra final)
- `PORT` lo proporciona Railway.

La app y `/api` se sirven desde el mismo host. El volumen persistente es necesario para conservar cuentas, passkeys y respaldos entre despliegues.

## Desarrollo local

Requiere Node.js 22 o posterior. Desde la raíz del repositorio:

```powershell
npm install
$env:APP_ORIGIN = 'http://localhost:3000'
npm start
```

Abre `http://localhost:3000`. WebAuthn admite `localhost` como origen seguro de desarrollo. Los datos del servidor local se guardan en `server/data/agenda.sqlite`.

## Repositorio y base local

Repositorio: <https://github.com/horaciosalvatierrag-cell/agenda-personal>

`schema.sql` describe las tablas locales `activities`, `completions` y `daily_notes`. `sql.js` mantiene la copia SQLite del navegador. El backend sincroniza esa copia como un archivo SQLite validado por la app antes de cargarlo.
