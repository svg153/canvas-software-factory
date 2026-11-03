# Orden de merge del tren de PRs

Cada PR corresponde a la rama `task/issue-<N>` de la issue `N`.

## Round 2/3 (PRs #65–#72)

| Issue | PR | Título |
|---|---|---|
| #57 | #67 | fix(adapters): eliminar shell:true y validar model |
| #61 | #65 | feat(sf-run): --timeout con kill de árbol y manejo SIGINT |
| #58 | #68 | fix(server): Host/Origin allowlist, token en todas las rutas, realpath |
| #63 | #66 | feat(sf-install): --check reporta archivos obsoletos |
| #62 | #70 | fix(desktop): iconos, frontendDist, parser testeado y CI honesto |
| #64 | #69 | docs(harnesses): verificar flags contra --help y eliminar ❓ |
| #60 | #71 | fix(runner): título aplanado y neutralizado dentro del bloque de datos |
| #59 | #72 | feat(runner): registro único de arneses; sf-run respeta config harness/model |

## Orden recomendado (por issue)

**#57 → #61 → #58 → #63 → #62 → #64 → #60 → #59**
(PRs: #67 → #65 → #68 → #66 → #70 → #69 → #71 → #72)

Conflictos ya resueltos en round 3:

- La rama `task/issue-59` (PR #72) **ya contiene** el trabajo de `task/issue-57` (PR #67) y `task/issue-61` (PR #65).
- La rama `task/issue-60` (PR #71) **ya contiene** `task/issue-64` (PR #69).

Si se mergea primero el contenedor, los PRs contenidos pueden cerrarse sin merge.

## Round 1 (PRs #45–#55)

Deben mergearse **antes** que los de round 2/3 (son su base): #45 (issue-37), #46 (35), #47 (36), #49 (43), #50 (42), #51 (38), #52 (40), #53 (44), #54 (39), #55 (41). Orden sugerido: por dependencia funcional (#51 adapters → #54 sf-run → #55 E2E; #52 server → #53 desktop). Todos figuran como mergeables.

Fuera del tren numerado: #56 (`svg153-repo-intake`, mergeable) y #48 (`svg153-user-idea-injection-flow`, **en conflicto**; requiere rebase).

## Advertencias

- No mergear ningún PR sin CI verde.
- Revalidar `mergeable` tras cada merge; puede requerir rebase.
- Los PRs contenidos en otros se cierran sin merge tras mergear el contenedor.
