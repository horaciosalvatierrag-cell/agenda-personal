# Agenda personal

Agenda instalable en español con calendario perpetuo, actividades, diario, notificaciones mientras la app está abierta y una galería local de fotos.

## Funciones

- Calendario mensual navegable sin límite de año, actividades recurrentes y marcas de completado.
- Diario por fecha con guardado automático y botón **Guardar nota**.
- SQLite local en IndexedDB, con exportación e importación de respaldos.
- Acceso mediante passkeys/WebAuthn y sincronización entre dispositivos con sesión autenticada.
- PWA instalable en Android y iPhone. El calendario y los datos locales funcionan sin conexión; la sincronización requiere internet.
- Galería local: incorpora fotografías seleccionadas manualmente, conserva sus originales y miniaturas en el dispositivo y no sube fotos a Internet.
- Finanzas personales: movimientos de ingresos y gastos, deudas y abonos, objetivos de ahorro, presupuestos, resumen, calendario y reportes con exportación CSV e impresión.
- Contactos privados: datos y archivos cifrados localmente, historial, recordatorios, importación CSV/vCard y respaldo JSON; independientes de la agenda nativa y de la sincronización.

## Passkeys, privacidad y sincronización

El inicio con Google se retiró. En un teléfono compatible, el sistema puede verificar una passkey con huella, rostro, PIN o el método de desbloqueo configurado. La app no recibe ni almacena datos biométricos. Para usar otro dispositivo, inicia sesión con una passkey disponible/sincronizada por el sistema de credenciales o usa el flujo de passkey entre dispositivos del navegador; después puedes registrar una passkey adicional en ese dispositivo.

El navegador crea y firma los retos; el backend valida las firmas, el origen, el dominio de la app y la verificación del usuario. Las sesiones usan cookies `HttpOnly`, `Secure` y `SameSite=Strict`. El servidor guarda el respaldo SQLite en un volumen persistente de Railway. La conexión viaja por HTTPS; el contenido del respaldo no tiene cifrado de extremo a extremo ni cifrado adicional de aplicación en reposo. La sincronización usa revisión optimista: si otra copia cambió mientras el dispositivo estaba desconectado, la app ofrece recibir la copia de nube o conservar la local. Antes de reemplazar una copia, descarga un respaldo SQLite local.

GitHub Pages por sí solo no puede validar passkeys. El backend y la app se sirven desde el mismo dominio de Railway porque WebAuthn requiere que el sitio y su RP ID coincidan. GitHub conserva el código y activa el despliegue de Pages; la URL de Railway es la dirección para usar passkeys y sincronización.

## Fotos y almacenamiento local

**Elegir fotos** es la única forma de añadir imágenes. La galería no selecciona carpetas, no recorre tarjetas SD y no explora archivos que el usuario no elija. Cada archivo se identifica mediante SHA-256; el mismo contenido se omite aunque tenga otro nombre. Se conservan los originales sin recomprimir y se crea una miniatura separada para la cuadrícula.

La biblioteca nueva usa IndexedDB (`AgendaSelectedPhotoLibrary`) para guardar el catálogo, los originales y las miniaturas de forma local y persistente. Se muestran 60 fotografías por página, ordenadas por fecha de modificación descendente; el visor usa el original almacenado cuando el navegador puede mostrarlo. Las URL blob son temporales y se liberan al cambiar de página o cerrar el visor. Se consulta el espacio disponible y se solicita persistencia al navegador cuando está disponible; la cuota sigue dependiendo del navegador y del espacio del dispositivo.

El índice anterior de carpetas (`AgendaPhotoFolder`) se conserva intacto como respaldo, pero ya no se usa para mostrar la nueva biblioteca. La nueva galería empieza vacía y se construye únicamente con las fotografías que selecciones. El archivo que estaba procesándose queda en una cola local y se intenta completar al volver a abrir la galería; si la app se cerró antes de procesar el resto de la selección, vuelve a elegir esos archivos y los ya incorporados se omitirán como duplicados.

## Finanzas personales

Las finanzas se guardan en una base IndexedDB independiente (`AgendaFinanzasLocal`) en el mismo dispositivo y origen. No se añaden a la base SQLite de Agenda ni al endpoint de sincronización; por tanto, no se envían al servicio de sincronización existente. Para moverlas entre dispositivos, usa **Respaldar finanzas JSON** desde Reportes y restaura ese archivo en el otro dispositivo. La restauración reemplaza los datos financieros locales actuales, después de pedir confirmación. Protege el archivo de respaldo como información sensible.

El balance mensual resta a los ingresos los gastos registrados y los abonos que no tengan un gasto vinculado. El disponible resta los gastos que no están vinculados a un abono, todos los abonos y las aportaciones a ahorro; si registras el abono junto a un gasto, se contabiliza una sola vez. Si detecta un gasto existente con la misma fecha e importe al capturar el abono, permite vincularlos. Los retiros solo actualizan el saldo del objetivo de ahorro. Los movimientos pendientes aparecen identificados, y el resumen usa los registros del mes seleccionado.

## Bóveda de contraseñas

La bóveda guarda los registros en una base IndexedDB independiente (`AgendaPasswordVault`) en el navegador y dispositivo actuales; no se sincroniza ni se envía al servicio de Agenda. Al primer acceso, el usuario crea y confirma su propio PIN de seis dígitos. El PIN nunca se guarda: Web Crypto deriva una clave AES-256-GCM mediante PBKDF2-SHA-256 con sal aleatoria (600 000 iteraciones). Cada registro y la comprobación del PIN se cifran con IV aleatorios distintos. La clave solo permanece en memoria mientras la bóveda está desbloqueada; se bloquea al salir de la sección, ocultar la página o tras cinco minutos sin actividad.

Un PIN de seis dígitos tiene solo un millón de combinaciones posibles. PBKDF2 y los bloqueos temporales dificultan intentos, pero no hacen que un PIN corto resista indefinidamente un ataque fuera de línea sobre una copia del almacenamiento. Elige un PIN que no uses en otros servicios, conserva el dispositivo protegido y no borres los datos del navegador: al olvidar el PIN no hay recuperación. La bóveda requiere HTTPS o `localhost` y un navegador con IndexedDB y Web Crypto.

## Contactos locales

Contactos mantiene una agenda separada de los contactos del teléfono. Los datos, el historial, recordatorios, fotos y audios se guardan en IndexedDB (`AgendaContactosLocal`); la información personal y los archivos quedan cifrados localmente con AES-GCM mediante Web Crypto y una clave no exportable guardada en IndexedDB. No se agregan a SQLite, a la sincronización de Agenda ni a ningún endpoint. El cifrado local no protege frente a código malicioso ejecutado en el mismo origen o al acceso a una sesión abierta del navegador. Un respaldo JSON contiene los datos descifrados y archivos adjuntos para que se pueda restaurar, por lo que debe protegerse como información sensible. La restauración agrega los contactos no duplicados y no reemplaza los existentes.

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

### Diario de voz y privacidad

El Diario conserva sus notas escritas en SQLite local. Para mantenerlas en el dispositivo, las nuevas copias de sincronización excluyen `daily_notes`; al recibir una copia se preservan las notas ya existentes localmente. La sincronización previa pudo haber incluido notas escritas: este cambio no puede retirar copias históricas que ya conserve el servidor.

Las grabaciones, transcripciones, etiquetas y observaciones se almacenan en una base IndexedDB independiente (`AgendaDiaryVoiceLocal`). Los datos quedan en el perfil local del navegador y no están cifrados en reposo. No se incorporan a la sincronización ni se transmiten. El botón **Exportar respaldo del Diario** crea un JSON local que incluye las notas escritas y las entradas de voz con sus audios; el usuario debe guardar ese archivo en un lugar privado. La restauración agrega registros sin reemplazar notas escritas existentes.

La grabación usa `getUserMedia` y `MediaRecorder`; solo comienza después de pulsar **Grabar nota de voz**, solicita permiso del micrófono y requiere HTTPS o localhost. La transcripción usa exclusivamente `SpeechRecognition` cuando el navegador permite activar `processLocally`. El navegador puede requerir que el usuario prepare explícitamente paquetes de idioma desde **Preparar idiomas locales**; esa acción puede descargar paquetes del navegador, pero el audio de la grabación se procesa en el dispositivo. Si no se confirma el modo local, no se intenta transcripción remota. En ese caso el audio aún se puede escuchar, guardar y transcribir manualmente.

La detección automática es de mejor esfuerzo: compara reconocimiento local en español de México e inglés estadounidense, y conserva el resultado más confiable; puede fallar con habla mezclada, ruido o frases cortas. Inglés británico está disponible como selección explícita si el navegador ofrece el paquete. No se traduce el texto. La disponibilidad de grabación, dictado, paquetes locales y entrada de pista de audio depende del navegador y puede variar en iOS y Android.

### Respaldo completo y restauración local

En **Configuración → Respaldo y restauración**, escribe una contraseña de al menos 12 caracteres y pulsa **Crear respaldo**. Agenda crea un ZIP local cifrado con AES-256-GCM por bloques; PBKDF2-SHA-256 deriva la clave. La contraseña no se guarda ni se transmite. Conserva el ZIP y la contraseña por separado: no es posible recuperar una contraseña olvidada.

El paquete incluye la base SQLite (calendario, actividades, recurrencias, historial y diario escrito), los almacenes IndexedDB de Finanzas, Contactos, Imágenes y Bóveda, las preferencias de idioma y tema y, si existe, `AgendaDiaryVoiceLocal`. Se incluyen originales y miniaturas de Imágenes. Contactos y sus adjuntos se vuelven a cifrar con una clave local nueva al restaurar; las credenciales de la Bóveda viajan cifradas y requieren el mismo PIN. El PIN y la clave local de Contactos no se exportan. No se exportan credenciales de sesión ni copias de sincronización.

Para trasladar los datos, instala/abre Agenda en el otro dispositivo, entra a **Configuración**, escribe la contraseña del archivo, pulsa **Restaurar respaldo**, selecciona el ZIP y espera la verificación. Revisa el resumen, elige **Restauración completa** o **Incorporar información**, marca la confirmación y continúa. Antes de restaurar, Agenda genera una copia cifrada del estado actual; guárdala. Al terminar, la app se recarga.

El respaldo no usa servicios externos ni sincroniza dispositivos. La restauración valida el cifrado antes de cambiar los almacenes y conserva una copia del estado local para intentar una recuperación si falla una fase. El navegador puede limitar memoria y almacenamiento. En esta versión, la restauración rechaza archivos mayores de 512 MB y aplica un límite menor en dispositivos con poca RAM; la creación se detiene si el contenido estimado supera unos 410 MB. Las pruebas de esta entrega no certifican bibliotecas fotográficas de 100,000 elementos ni archivos de varios GB. El formato ZIP guarda las entradas sin compresión para evitar una segunda decodificación costosa de fotografías.
