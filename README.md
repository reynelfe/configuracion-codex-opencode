# Codex OpenCode MCP

Controla OpenCode CLI desde Codex: sesiones persistentes, instrucciones, actividad incremental, interrupción y reanudación del historial. Implementado y probado en Linux con OpenCode **2.2.4** y Node **26**. Requiere la API de OpenCode 2.

## Requisitos

- Linux y Node.js 22 o posterior, con npm.
- Python 3.11 o posterior: el instalador usa `tomllib` para verificar la configuración.
- Codex CLI disponible en `PATH`, con soporte para `codex mcp add`, y su archivo de configuración existente.
- OpenCode CLI 2 instalado y configurado con un proveedor o modelo disponible. Puedes comprobarlo con `opencode --version`, `opencode models` y `opencode auth list`.

## Instalación

```sh
git clone https://github.com/reynelfe/configuracion-codex-opencode.git
cd configuracion-codex-opencode
npm ci --ignore-scripts
npm test
npm run install:codex
```

El instalador copia el runtime a `~/.local/share/codex-opencode-mcp`, registra el MCP `opencode` a nivel de usuario y guarda una copia de `~/.codex/config.toml` antes de modificarlo. Comprueba que el resto de la configuración conserve su valor. Usa `XDG_DATA_HOME` y `CODEX_HOME` si están definidos. La instalación incluye las dependencias fijadas por `package-lock.json`.

Reinicia Codex para cargar las herramientas de un MCP recién registrado. No hace falta volver a instalar OpenCode ni iniciar sesión otra vez: se usa su servicio local y sus credenciales existentes mediante `opencode api`.

## Herramientas

| Herramienta | Función |
|---|---|
| `opencode_status` | Versión, servicio, modelos y proveedores conectados, sin credenciales |
| `opencode_session_create` | Crear sesión o retomar un `sessionId` en un `cwd` absoluto |
| `opencode_session_list` | Ver sesiones adjuntas a este proceso MCP |
| `opencode_session_prompt` | Enviar una instrucción; devuelve actividad mientras continúa |
| `opencode_session_watch` | Leer nuevos eventos desde `nextCursor` |
| `opencode_session_interrupt` | Cancelar ejecución en OpenCode, opcionalmente enviar otra instrucción |
| `opencode_session_close` | Cancelar si es necesario y desacoplar, conservando el historial |
| `opencode_run` | Crear sesión y comenzar una tarea en una llamada |

Ejemplo de sesión:

```json
{"cwd":"/ruta/absoluta/a/mi/proyecto","agent":"build","autoApprove":true}
```

Después envía `sessionId` y `prompt` a `opencode_session_prompt`. Si `state` sigue en `running`, llama a `opencode_session_watch` usando el `nextCursor` anterior hasta el resultado final. La ventana de observación tiene un máximo de 60 segundos; el plazo de ejecución predeterminado es de 10 minutos. Cerrar una sesión no elimina su conversación de OpenCode; para retomarla, pasa su `sessionId` y el mismo `cwd` a `opencode_session_create`.

El modelo se toma de tu configuración de OpenCode. Puedes elegir otro con `model: "provider/model#variant"`. El MCP no cambia el modelo global. Las verificaciones reales de esta entrega usan `opencode/flint-40b-free`.

## Permisos y límites

`autoApprove` vale `false` por defecto. OpenCode `run` es un cliente no interactivo: las solicitudes `ask` se rechazan automáticamente. Para una tarea autónoma autorizada, usa `autoApprove:true`; esto añade `--auto` y conserva las reglas `deny` explícitas. Los errores de herramientas y bloqueos aparecen en la actividad. `agent:"plan"` selecciona el agente de planificación de OpenCode; no constituye un aislamiento del sistema operativo. OpenCode ejecuta herramientas con los permisos de tu usuario y su configuración.

El MCP admite tres sesiones adjuntas y un turno activo por sesión. Conserva hasta 300 eventos recientes y 100 000 caracteres de respuesta por sesión. `eventsTruncated` indica cuando el cursor quedó atrás de la ventana disponible. El historial completo permanece en OpenCode.

`session_list` muestra las sesiones gestionadas por este proceso MCP. Puedes consultar otros identificadores con `opencode session list` y adjuntarlos mediante `session_create`. Si otro cliente opera sobre la misma conversación, sus cambios y cancelaciones afectan esa sesión nativa; usa sesiones separadas para tareas independientes.

La cancelación usa `POST /api/session/{id}/interrupt?resume=false`; detener solamente el proceso cliente no garantiza detener la tarea del servicio. El adaptador comprueba la cancelación y comunica los errores. Al cerrar el MCP intenta cancelar sus turnos activos. Si se termina el proceso abruptamente con `SIGKILL`, no puede ejecutar esa limpieza.

Si la conexión falla durante una cancelación, `cancellationUnconfirmed:true` impide reutilizar o desacoplar esa sesión hasta que `session_interrupt` confirme que OpenCode quedó inactivo. Cuando el servicio vuelve a responder, puede reintentarse la cancelación.

Variables opcionales:

| Variable | Uso |
|---|---|
| `OPENCODE_BIN` | Ruta del ejecutable OpenCode |
| `OPENCODE_DEFAULT_MODEL` | Modelo predeterminado de este adaptador |
| `OPENCODE_SERVER_URL` | Servicio OpenCode explícito, en lugar del compartido local |

## Verificación

`npm test` usa un CLI simulado para comprobar errores, fragmentación JSONL, concurrencia, cancelación, tiempos límite, cursores y protocolo MCP. `npm run smoke` ejecuta inferencia real con el modelo gratuito, lee un archivo de prueba, verifica memoria entre turnos, crea un archivo y reanuda una conversación cerrada. Usa un directorio temporal y conserva su ruta en la salida. El smoke selecciona el modelo gratuito explícitamente y no altera tu configuración global.

El smoke usa `opencode/flint-40b-free` por defecto. Su disponibilidad depende de la cuota del proveedor; si devuelve `Free usage limit reached`, el MCP comunica el error. Puedes elegir otro modelo disponible para la prueba con `SMOKE_MODEL=provider/model npm run smoke`. Esa prueba usa el proveedor seleccionado y puede consumir su cuota o saldo.

La suite `npm test` usa un CLI simulado y no necesita credenciales ni hace inferencia. Durante la validación inicial pasaron 15 pruebas y se comprobaron lectura, escritura, memoria e interrupción reales con coste reportado 0.

Documentación oficial usada: [OpenCode API v2](https://opencode.ai/v2/docs/api), [comandos CLI](https://dev.opencode.ai/v2/docs/cli/commands/), [permisos](https://dev.opencode.ai/v2/docs/permissions/).
