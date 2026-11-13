# Agenda personal

Agenda instalable, en español, con calendario perpetuo y almacenamiento privado en el propio dispositivo.

## Funciones

- Calendario mensual navegable sin límite de año, con actividades y selección de día.
- Alta, edición, búsqueda, categoría y eliminación de actividades; repetición diaria, semanal, mensual o anual.
- Marcas de completado por cada fecha, incluyendo cada repetición.
- Diario con notas por día, marca de fecha importante y consulta de las 12 notas recientes.
- Notificaciones del navegador para actividades con hora. Se revisan mientras la aplicación está abierta.
- Base SQLite local con actividades, completados y notas de diario.
- Guardado local persistente en el navegador, exportación e importación de respaldo `.sqlite`.
- Aplicación web progresiva (PWA): al cargarla por primera vez con internet, guarda sus archivos para uso posterior sin conexión.
- Botón de instalación para añadirla al inicio del celular; incluye iconos de 192 y 512 px y guía para iPhone.
- Visor local para fotos y videos que el usuario elige desde el dispositivo o desde una carpeta seleccionada.
- Inicio de sesión Google y copia SQLite en el espacio privado de datos de la aplicación en Drive; usa el alcance limitado `drive.appdata`.

## Privacidad y límites

La copia local permanece en el navegador. Al conectar Google, la app sincroniza la base SQLite como un archivo oculto de datos de la aplicación en Drive; pide el alcance limitado `drive.appdata`, no acceso a los demás archivos de Drive. Los archivos de esa carpeta especial no aparecen en la interfaz normal de Drive y solo esta aplicación puede leerlos. La copia de Drive almacena la base SQLite sin cifrado de extremo a extremo. El inicio de sesión conecta la sincronización, pero no bloquea el acceso a la copia local del navegador. Si dos dispositivos tienen cambios distintos, la app pide elegir qué copia conservar para evitar reemplazos silenciosos. Al usar otro navegador, conecta la cuenta y la app descarga la copia. **Exportar respaldo** permite guardar una copia adicional fuera de Drive. Las notificaciones requieren permiso y que la app siga abierta.

El ID OAuth de cliente no es secreto y se incluye en el código del sitio. Nunca configures ni publiques un secreto OAuth en esta app de navegador. El token de acceso se mantiene en memoria y se solicita de nuevo cuando vence o al iniciar otra sesión del navegador.

## Ejecutar en Windows

1. Instala Node.js si aún no está instalado.
2. Abre PowerShell en esta carpeta.
3. Ejecuta `npx serve .` (si pregunta, permite la instalación temporal de `serve`).
4. Abre la dirección local que muestre la consola, normalmente `http://localhost:3000`.
5. Usa **Nueva actividad** para comenzar. Permite notificaciones si deseas avisos mientras la agenda permanezca abierta.

Un servidor local (`localhost`) permite que el navegador use el service worker y SQLite WebAssembly. Abrir `index.html` con doble clic no habilita bien esas funciones.

## Instalar en el celular y ver medios locales

1. Abre la URL de GitHub Pages en Chrome para Android o Safari para iPhone/iPad.
2. Pulsa **Instalar app** y confirma. Si el navegador no muestra una instalación directa, sigue las instrucciones del botón; en iPhone se usa **Compartir → Añadir a pantalla de inicio**.
3. Abre **Fotos y videos** y selecciona archivos o una carpeta del teléfono. Chrome/Android abrirá el selector del sistema; puedes elegir la tarjeta SD desde ese selector si está disponible.

Por seguridad, una PWA no obtiene acceso general a toda la tarjeta SD. Solo puede leer los archivos o la carpeta que eliges explícitamente en el selector. Los medios seleccionados se leen localmente y no se copian a la base SQLite ni se suben a Drive. Para acceso nativo más amplio a bibliotecas multimedia se necesitaría una app Android separada con permisos del sistema.

## Publicar con GitHub Pages

1. Crea un repositorio GitHub propio llamado `agenda-personal`.
2. Desde esta carpeta ejecuta `git init`, `git add .`, `git commit -m "Crear agenda personal offline"`, y `git branch -M main`.
3. Añade el remoto con `git remote add origin https://github.com/TU_USUARIO/agenda-personal.git` y ejecuta `git push -u origin main`.
4. En GitHub abre **Settings → Pages**, selecciona **Deploy from a branch**, elige `main` y la carpeta `/ (root)`, y pulsa **Save**.
5. La URL será `https://TU_USUARIO.github.io/agenda-personal/`. GitHub Pages puede tardar unos minutos en publicarla.
6. Abre la URL con conexión al menos una vez desde cada dispositivo y navegador donde quieras usarla sin conexión; instala la PWA desde el navegador para acceder como aplicación.

## Configurar inicio de sesión y sincronización Google

El sitio ya tiene el flujo de Google Identity Services y usa Google Drive `appDataFolder` para una copia SQLite por cuenta. Para habilitarlo con tu cuenta:

1. En Google Cloud Console, crea o selecciona un proyecto y habilita **Google Drive API**.
2. Configura la pantalla de consentimiento OAuth como **External**. Mientras la app esté en prueba, agrega tu cuenta Google a **Test users**.
3. Crea un OAuth Client ID de tipo **Web application**. Añade `https://horaciosalvatierrag-cell.github.io` en **Authorized JavaScript origins**. No necesitas un redirect URI para este flujo.
4. Copia el Client ID terminado en `.apps.googleusercontent.com` a `google-config.js`, dentro de las comillas. No copies un client secret.
5. Haz commit y push para que GitHub Pages publique la configuración. Entra al sitio, pulsa **Conectar Google** y aprueba el acceso solicitado al espacio privado de datos de Agenda en Drive.
6. Para usar otro dispositivo, abre el sitio con internet, inicia sesión con la misma cuenta y sincroniza. La app te pedirá elegir una copia si detecta cambios distintos.

Google requiere internet para iniciar sesión y sincronizar; la agenda local sigue funcionando sin conexión y sincroniza los cambios pendientes al volver a conectarse si la sesión de Google sigue vigente.

## Esquema SQL

`schema.sql` documenta el esquema usado por la aplicación. `sql.js` (incluido en `vendor/`) ejecuta SQLite/WebAssembly en el navegador; el archivo de base de datos se persiste localmente en IndexedDB y se puede exportar como SQLite estándar.
