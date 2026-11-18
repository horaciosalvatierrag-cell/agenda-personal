# Agenda personal

Agenda instalable en español con calendario perpetuo, actividades, diario, notificaciones mientras la app está abierta y visor local de fotos y videos.

## Funciones

- Calendario mensual navegable sin límite de año, actividades recurrentes y marcas de completado.
- Diario por fecha con guardado automático y botón **Guardar nota**.
- SQLite local en IndexedDB, con exportación e importación de respaldos.
- Acceso mediante passkeys/WebAuthn y sincronización entre dispositivos con sesión autenticada.
- PWA instalable en Android y iPhone. El calendario y los datos locales funcionan sin conexión; la sincronización requiere internet.
- Galería local: muestra solo los archivos o carpetas seleccionados; no sube fotos o videos.
- Finanzas personales: movimientos de ingresos y gastos, deudas y abonos, objetivos de ahorro, presupuestos, resumen, calendario y reportes con exportación CSV e impresión.
- Contactos privados: datos y archivos cifrados localmente, historial, recordatorios, importación CSV/vCard y respaldo JSON; independientes de la agenda nativa y de la sincronización.

## Passkeys, privacidad y sincronización

El inicio con Google se retiró. En un teléfono compatible, el sistema puede verificar una passkey con huella, rostro, PIN o el método de desbloqueo configurado. La app no recibe ni almacena datos biométricos. Para usar otro dispositivo, inicia sesión con una passkey disponible/sincronizada por el sistema de credenciales o usa el flujo de passkey entre dispositivos del navegador; después puedes registrar una passkey adicional en ese dispositivo.

El navegador crea y firma los retos; el backend valida las firmas, el origen, el dominio de la app y la verificación del usuario. Las sesiones usan cookies `HttpOnly`, `Secure` y `SameSite=Strict`. El servidor guarda el respaldo SQLite en un volumen persistente de Railway. La conexión viaja por HTTPS; el contenido del respaldo no tiene cifrado de extremo a extremo ni cifrado adicional de aplicación en reposo. La sincronización usa revisión optimista: si otra copia cambió mientras el dispositivo estaba desconectado, la app ofrece recibir la copia de nube o conservar la local. Antes de reemplazar una copia, descarga un respaldo SQLite local.

GitHub Pages por sí solo no puede validar passkeys. El backend y la app se sirven desde el mismo dominio de Railway porque WebAuthn requiere que el sitio y su RP ID coincidan. GitHub conserva el código y activa el despliegue de Pages; la URL de Railway es la dirección para usar passkeys y sincronización.

## Fotos, videos y almacenamiento

La galería no sube ni guarda las fotos en la base de datos de la Agenda. En navegadores compatibles con File System Access API, **Elegir carpeta** conserva en IndexedDB el identificador local de la carpeta. En visitas posteriores intenta reabrirla automáticamente cuando el navegador mantenga el permiso; si este vuelve a `prompt`, se solicita permiso al pulsar el mismo botón, sin volver a elegir la carpeta. El permiso puede ser revocado desde el navegador.

Las imágenes de subcarpetas se recorren de forma recursiva. Las miniaturas se generan bajo demanda y la vista principal lee en resolución original solo la fotografía seleccionada. Las URL temporales se liberan al cambiar de imagen o salir de la página. En navegadores sin `showDirectoryPicker()` se conserva el selector de carpeta `webkitdirectory`; sus archivos son temporales y el navegador no puede recordar la carpeta. HEIC/HEIF solo se muestra si el navegador puede decodificarlo. Ningún archivo se transmite a servicios externos.

## Finanzas personales

Las finanzas se guardan en una base IndexedDB independiente (`AgendaFinanzasLocal`) en el mismo dispositivo y origen. No se añaden a la base SQLite de Agenda ni al endpoint de sincronización; por tanto, no se envían al servicio de sincronización existente. Para moverlas entre dispositivos, usa **Respaldar finanzas JSON** desde Reportes y restaura ese archivo en el otro dispositivo. La restauración reemplaza los datos financieros locales actuales, después de pedir confirmación. Protege el archivo de respaldo como información sensible.

El balance mensual resta a los ingresos los gastos registrados y los abonos que no tengan un gasto vinculado. El disponible resta los gastos que no están vinculados a un abono, todos los abonos y las aportaciones a ahorro; si registras el abono junto a un gasto, se contabiliza una sola vez. Si detecta un gasto existente con la misma fecha e importe al capturar el abono, permite vincularlos. Los retiros solo actualizan el saldo del objetivo de ahorro. Los movimientos pendientes aparecen identificados, y el resumen usa los registros del mes seleccionado.

## Bóveda de contraseñas

La bóveda guarda los registros en una base IndexedDB independiente (`AgendaPasswordVault`) en el navegador y dispositivo actuales; no se sincroniza ni se envía al servicio de Agenda. Al primer acceso, el usuario crea y confirma su propio PIN de seis dígitos. El PIN nunca se guarda: Web Crypto deriva una clave AES-256-GCM mediante PBKDF2-SHA-256 con sal aleatoria (600 000 iteraciones). Cada registro y la comprobación del PIN se cifran con IV aleatorios distintos. La clave solo permanece en memoria mientras la bóveda está desbloqueada; se bloquea al salir de la sección, ocultar la página o tras cinco minutos sin actividad.

Un PIN de seis dígitos tiene solo un millón de combinaciones posibles. PBKDF2 y los bloqueos temporales dificultan intentos, pero no hacen que un PIN corto resista indefinidamente un ataque fuera de línea sobre una copia del almacenamiento. Elige un PIN que no uses en otros servicios, conserva el dispositivo protegido y no borres los datos del navegador: al olvidar el PIN no hay recuperación. La bóveda requiere HTTPS o `localhost` y un navegador con IndexedDB y Web Crypto.

## Contactos locales

Contactos mantiene una agenda separada de los contactos del teléfono. Los datos, el historial, recordatorios, fotos y audios se guardan en IndexedDB (`AgendaContactosLocal`); la información personal y los archivos quedan cifrados localmente con AES-GCM mediante Web Crypto. No se agregan a SQLite, a la sincronización de Agenda ni a ningún endpoint. La clave no se exporta; un respaldo JSON contiene los datos descifrados y archivos adjuntos para que se pueda restaurar, por lo que debe protegerse como información sensible. La restauración agrega los contactos no duplicados y no reemplaza los existentes.

Los recordatorios y cumpleaños aparecen en calendario y Próximas, pero permanecen locales. Las notificaciones del navegador requieren que el usuario active permiso y que Agenda esté abierta; GitHub Pages no envía notificaciones cuando la app está cerrada. Llamar, correo y WhatsApp solo abren la aplicación elegida por el usuario. Las grabaciones se asocian únicamente al importar un archivo de audio que el usuario ya obtuvo con autorización; la app no graba ni intercepta llamadas.

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
