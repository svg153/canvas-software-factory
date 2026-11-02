# Arneses (harnesses): matriz CLI / flags / modelos

La fábrica es agnóstica del arnés: el runner (`sf.mjs`) solo gestiona estado y emite prompts; cualquier CLI de agente con modo headless puede ejecutarlos.
Los flags **no** están hardcodeados en el runner: viven solo en este documento.

> ⚠️ Los flags cambian entre versiones. Antes de usar un arnés, ejecuta `<cli> --help` y contrasta con esta tabla.
> Las celdas marcadas ❓ **no se han verificado** aún en una ejecución real; se anotará la versión del CLI al probarlas.

## Matriz

| Arnés | Comando headless | Prompt | Modelo | Permisos / seguridad | Ruta de instalación del skill |
|---|---|---|---|---|---|
| `copilot` | `copilot -p "<prompt>"` | arg (`-p`) | `--model <id>` | `--allow-all-tools` (o `--allow-tool`/`--deny-tool`) | `~/.copilot/skills/software-factory/` |
| `claude` | `claude -p` | stdin o arg | `--model <alias\|id>` | `--permission-mode acceptEdits` / `--allowedTools "<lista>"` ❓ | `~/.claude/skills/software-factory/` |
| `codex` | `codex exec -` | stdin (`-`) o arg | `-m <id>` | `--sandbox workspace-write` / `--full-auto` ❓ | `~/.codex/` (vía `AGENTS.md`) ❓ |
| `opencode` | `opencode run "<prompt>"` | arg | `-m <proveedor/modelo>` | permisos en `opencode.json` ❓ | `~/.config/opencode/` ❓ |
| `gemini` | `gemini -p "<prompt>"` | arg (`-p`) o stdin | `-m <id>` | `--yolo` (aprueba todo; solo en entornos aislados) ❓ | `~/.gemini/` (vía `GEMINI.md`) ❓ |
| `vscode-stub` | — (stub: sin modo headless) | — | — | — | Sin instalación; solo reserva el nombre |

## Caveats conocidos por versión

| CLI | Caveat | Cómo comprobarlo |
|---|---|---|
| copilot | Los flags de permisos han cambiado entre releases; en no interactivo hace falta `--allow-all-tools` | `copilot --help` |
| claude | `-p` es el modo no interactivo; el formato de `--allowedTools` varía | `claude --help` |
| codex | `exec` es el subcomando no interactivo; los nombres de sandbox han variado | `codex exec --help` |
| opencode | El modelo se expresa como `proveedor/modelo` | `opencode run --help` |
| gemini | `--yolo` desactiva confirmaciones | `gemini --help` |

Al verificar un arnés, anota aquí la versión (`<cli> --version`) y la fecha.

## Quickstart headless (sin Copilot App)

Requisitos: Node.js 20+, `git`, `gh` autenticado y el CLI del arnés elegido.

```bash
sf=com.github.copilot/extensions/software-factory/runner/sf.mjs

# 1. Instalar el skill en el arnés (en progreso: llega con PR #47)
node tools/sf-install.mjs --harness claude

# 2. Inicializar la fábrica en el repo objetivo
node $sf init

# 3. Bucle: siguiente work order -> CLI -> marcar completado
node $sf next --print-prompt | claude -p   # --print-prompt: en progreso (#45)
node $sf complete                          # args exactos: `node $sf --help` (#37 en progreso)
node $sf status
```

En esta rama existen `init`, `start`, `next`, `complete` y `status`; `--print-prompt` y el bucle automatizado llegan con #45 / #37.
Sustituye `claude -p` por el comando de tu arnés de la matriz.
