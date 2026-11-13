# Diario personal

Aplicación web instalable para escribir notas por día, marcarlas como importantes y volver a consultar las notas recientes.

## Guardado y privacidad

- Las notas se guardan como SQLite en el almacenamiento local del navegador (IndexedDB).
- El guardado automático y el botón Guardar nota usan la misma ruta de guardado. El estado confirma el resultado después de que IndexedDB completa la escritura.
- Funciona sin conexión después de abrir la aplicación una vez.
- Usa Exportar respaldo para guardar una copia .sqlite. Los datos locales no se sincronizan entre dispositivos.
- Borrar los datos del navegador puede borrar las notas; guarda respaldos periódicos.

## Instalar

Abre la aplicación por HTTPS y pulsa Instalar app. También puedes agregarla desde el menú del navegador.

## Desarrollo local

Sirve la carpeta por HTTP (por ejemplo, con npx serve .) y abre la dirección que indique el servidor. Se necesita HTTPS o localhost para instalar la PWA y permitir el almacenamiento seguro del navegador.

## Publicación

El repositorio publica los archivos estáticos en GitHub Pages al actualizar la rama main. GitHub Pages es el alojamiento de esta versión; Railway ya no forma parte del funcionamiento del Diario.

Repositorio: <https://github.com/horaciosalvatierrag-cell/agenda-personal>
