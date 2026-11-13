# Agenda personal

Agenda instalable en español, con calendario perpetuo, actividades, diario personal y visor local de fotos y videos.

## Funciones

- Calendario mensual navegable sin límite de año y lista de actividades.
- Actividades con categorías, repetición diaria/semanal/mensual/anual y marcas de completado por fecha.
- Diario con notas por día, marca de días importantes, notas recientes, guardado automático y botón **Guardar nota**.
- Copia SQLite local persistente en el navegador, con exportación/importación `.sqlite`.
- Instalación como PWA en Android y iPhone; los archivos necesarios para abrirla sin conexión se almacenan tras la primera visita.
- Galería local: muestra fotos y videos que el usuario selecciona, sin copiarlos a SQLite ni subirlos.

## Datos y acceso

Las actividades y notas se guardan en IndexedDB como un archivo SQLite local. Ahora mismo no existe sincronización entre dispositivos ni autenticación. El inicio de sesión de Google se retiró. Para sincronizar de forma segura con passkeys/biometría hace falta un backend que emita y valide los retos WebAuthn y almacene la copia compartida; la publicación estática de GitHub Pages no puede hacerlo por sí sola. El navegador puede pedir huella/rostro como verificación de una passkey, con PIN u otro método del dispositivo como alternativa. La app nunca obtiene ni almacena datos biométricos.

Una PWA tampoco recibe acceso general a toda la tarjeta SD. El visor solo lee los archivos o la carpeta que se selecciona explícitamente. Los archivos multimedia no se guardan ni se suben. El espacio libre del teléfono no es accesible desde la página.

## Instalar en el celular

1. Abre la [agenda publicada](https://horaciosalvatierrag-cell.github.io/agenda-personal/) en Chrome para Android o Safari para iPhone/iPad.
2. Pulsa **Instalar app** y confirma. En iPhone, usa **Compartir → Añadir a pantalla de inicio**.
3. Abre **Fotos y videos** y elige archivos o una carpeta desde el selector del sistema.

## Ejecutar en Windows

1. Instala Node.js si aún no está instalado.
2. Abre PowerShell en esta carpeta y ejecuta `npx serve .`.
3. Abre la URL local de la consola, normalmente `http://localhost:3000`.

Se necesita un servidor `localhost` para usar el service worker y SQLite WebAssembly; no abras `index.html` con doble clic.

## Publicación

Repositorio: <https://github.com/horaciosalvatierrag-cell/agenda-personal>

Sitio: <https://horaciosalvatierrag-cell.github.io/agenda-personal/>

GitHub Actions publica automáticamente los cambios de `main` en GitHub Pages.

## Base de datos

`schema.sql` describe las tablas `activities`, `completions` y `daily_notes`. `sql.js` se incluye en `vendor/` y guarda SQLite localmente; **Exportar respaldo** genera un archivo SQLite estándar.
