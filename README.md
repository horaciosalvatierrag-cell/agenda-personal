# Agenda personal

Agenda instalable, en español, con calendario perpetuo y almacenamiento privado en el propio dispositivo.

## Funciones

- Calendario mensual navegable sin límite de año, con actividades y selección de día.
- Alta, edición, búsqueda, categoría y eliminación de actividades; repetición diaria, semanal, mensual o anual.
- Marcas de completado por cada fecha, incluyendo cada repetición.
- Diario con notas por día, marca de fecha importante y consulta de las 12 notas recientes.
- Notificaciones del navegador para actividades con hora. Se revisan mientras la aplicación está abierta.
- Base de datos SQLite con las tablas `activities` y `completions`.
- Guardado local persistente en el navegador, exportación e importación de respaldo `.sqlite`.
- Aplicación web progresiva (PWA): al cargarla por primera vez con internet, guarda sus archivos para uso posterior sin conexión.

## Privacidad y límites

Las actividades permanecen en el almacenamiento del navegador que las creó. No se sincronizan automáticamente entre dispositivos y borrar los datos del navegador puede borrarlas; usa **Exportar respaldo** periódicamente. Publicar el código en GitHub no publica el archivo SQLite de tus actividades. Las notificaciones dependen del permiso del navegador y no se disparan si el navegador/sistema no mantiene activa la aplicación.

## Ejecutar en Windows

1. Instala Node.js si aún no está instalado.
2. Abre PowerShell en esta carpeta.
3. Ejecuta `npx serve .` (si pregunta, permite la instalación temporal de `serve`).
4. Abre la dirección local que muestre la consola, normalmente `http://localhost:3000`.
5. Usa **Nueva actividad** para comenzar. Permite notificaciones si deseas avisos mientras la agenda permanezca abierta.

Un servidor local (`localhost`) permite que el navegador use el service worker y SQLite WebAssembly. Abrir `index.html` con doble clic no habilita bien esas funciones.

## Publicar con GitHub Pages

1. Crea un repositorio GitHub propio llamado `agenda-personal`.
2. Desde esta carpeta ejecuta `git init`, `git add .`, `git commit -m "Crear agenda personal offline"`, y `git branch -M main`.
3. Añade el remoto con `git remote add origin https://github.com/TU_USUARIO/agenda-personal.git` y ejecuta `git push -u origin main`.
4. En GitHub abre **Settings → Pages**, selecciona **Deploy from a branch**, elige `main` y la carpeta `/ (root)`, y pulsa **Save**.
5. La URL será `https://TU_USUARIO.github.io/agenda-personal/`. GitHub Pages puede tardar unos minutos en publicarla.
6. Abre la URL con conexión al menos una vez desde cada dispositivo y navegador donde quieras usarla sin conexión; instala la PWA desde el navegador para acceder como aplicación.

## Esquema SQL

`schema.sql` documenta el esquema usado por la aplicación. `sql.js` (incluido en `vendor/`) ejecuta SQLite/WebAssembly en el navegador; el archivo de base de datos se persiste localmente en IndexedDB y se puede exportar como SQLite estándar.
