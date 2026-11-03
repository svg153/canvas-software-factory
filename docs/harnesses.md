# Arneses (harnesses): matriz CLI / flags / modelos

La fábrica es agnóstica del arnés: el runner (`sf.mjs`) solo gestiona estado y emite prompts; cualquier CLI de agente con modo headless puede ejecutarlos.
Los flags **no** están hardcodeados en el runner: viven solo en este documento.

> ⚠️ Los flags cambian entre versiones. Antes de usar un arnés, ejecuta `<cli> --help` y contrasta con esta tabla.
> Verificado contra `--help` solo para los CLI instalados (ver "Verificado con"); el resto queda con nota al pie ¹. El código fuente de verdad para lo que soporta la fábrica es el runner; en esta rama no existen adaptadores (`runner/lib/adapters`).

## Matriz

| Arnés | Comando headless | Prompt | Modelo | Permisos / seguridad | Ruta de instalación del skill |
|---|---|---|---|---|---|
| `copilot` | `copilot -p "<prompt>"` | arg (`-p`) | `--model <id>` | `--allow-all-tools` (o `--allow-tool`/`--deny-tool`) | `~/.copilot/skills/software-factory/` |
| `claude` | `claude -p` | stdin o arg | `--model <alias\|id>` | `--permission-mode acceptEdits` / `--allowedTools "<lista>"` ¹ | `~/.claude/skills/software-factory/` |
| `codex` | `codex exec -` | stdin (`-`) o arg | `-m <id>` | `--sandbox workspace-write` (`read-only`, `workspace-write`, `danger-full-access`) | `~/.codex/` (vía `AGENTS.md`) |
| `opencode` | `opencode run "<prompt>"` | arg | `-m <proveedor/modelo>` | permisos en `opencode.json`; `--auto` auto-aprueba (peligroso) | `~/.config/opencode/` |
| `gemini` | `gemini -p "<prompt>"` | arg (`-p`) o stdin | `-m <id>` | `--yolo` (aprueba todo; solo en entornos aislados) ¹ | `~/.gemini/` (vía `GEMINI.md`) ¹ |
| `vscode-stub` | — (stub: sin modo headless) | — | — | — | Sin instalación; solo reserva el nombre |

## Caveats conocidos por versión

| CLI | Caveat | Cómo comprobarlo |
|---|---|---|
| copilot | Los flags de permisos han cambiado entre releases; en no interactivo hace falta `--allow-all-tools` | `copilot --help` |
| claude | `-p` es el modo no interactivo; el formato de `--allowedTools` varía | `claude --help` |
| codex | `exec` es el subcomando no interactivo; los nombres de sandbox han variado | `codex exec --help` |
| opencode | El modelo se expresa como `proveedor/modelo` | `opencode run --help` |
| gemini | `--yolo` desactiva confirmaciones | `gemini --help` |

## Verificado con

| CLI | Versión | Fecha | Verificado con `--help` |
|---|---|---|---|
| copilot | 1.0.106-2 | 2026-11-02 | `-p/--prompt`, `--model`, `--allow-all-tools`, `--allow-tool`, `--deny-tool` (existen también `--allow-all`/`--yolo`) |
| codex | codex-cli 0.155.1 | 2026-11-02 | `codex exec [PROMPT]` (stdin si no hay prompt; si ambos, stdin se añade como bloque `<stdin>`), `-m/--model`, `-s/--sandbox`. **`--full-auto` no aparece en `codex exec --help`: eliminado de la matriz** |
| opencode | 1.18.31 | 2026-11-02 | `opencode run [message..]`, `-m/--model` (`provider/model`), `--auto` |
| claude | — | — | ¹ |
| gemini | — | — | ¹ |

¹ Pendiente de verificación con --help (2026-11-02, máquina Windows sin claude ni gemini). Las celdas de estas filas reflejan conocimiento previo, no una prueba.

Nota: la existencia de `~/.codex/`, `~/.config/opencode/` y `~/.copilot/skills/` en esta máquina es lo único comprobado sobre rutas de skills; no se ha verificado cómo cada CLI las carga.

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
