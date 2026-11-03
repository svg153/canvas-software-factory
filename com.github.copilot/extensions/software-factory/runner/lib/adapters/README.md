# Adapters

## Limitación conocida: opencode en Windows (fail-closed)

`opencode run [message..]` recibe el prompt como argumento (argv). En Windows,
si el binario resuelto es un shim `.cmd`, los argumentos se validan contra un
charset estricto y cualquier argumento fuera de él se **rechaza** (fail-closed,
sin pasar por shell). Un prompt con comillas, `&&`, etc. suele rechazarse, de modo
que opencode puede quedar inutilizable en Windows con prompts arbitrarios.

No se cambió a entrega por stdin porque `opencode run --help` (v1.18.31) no
documenta lectura del prompt por stdin y no se pudo verificar. Mientras no se
verifique, el rechazo se mantiene (seguridad > funcionalidad). Alternativas:
usar un binario nativo (`.exe`), otro arnés (copilot/claude/codex/gemini, que
usan stdin), o ejecutar opencode vía WSL.
