# BASELINE

branch: `codex/dynamic-workers-3090` на входе, commit `add9eff`; текущая реализация находится в новой ветке `codex/adaptive-orchestrator-3090`.

commit исходного DSH: `da4bebc8e7457ff07431a19a5c1ac9cf0111bc03` с прежними незакоммиченными изменениями. Исходный checkout и экспериментальная копия оркестратора не изменялись.

old NInfer command: `--max-context 8192 --kv-capacity 16384 --max-concurrency 6 --kv-dtype int8` с vision и MTP.

old DSH config: отдельный профиль `web-multiagent-3090`; резервная копия `/home/diffusionlab/backups/dynamic-workers-3090-20260916T104739Z`.

baseline tests: на входе были сохранены проверки плагина, очередь, context limiter, NInfer integration и benchmark scripts; после изменений `pnpm check`, `pnpm test`, `pnpm build` и `git diff --check` проходят.

# CHANGES

files changed: `src/index.ts`, `src/types.ts`, `src/adaptive.ts`, `src/orchestration-script.ts`, `src/resource-manager.ts`, `tests/task-orchestrator.spec.ts`, `bench/campaign.py`, `README.md`, `README.zh.md`, `CHANGELOG.md`, `package.json`, этот отчёт и `plans/adaptive-orchestrator-3090-note.md`.

new components: динамические уровни 8/16/24/32/48/64K, изолированный task package, жадная упаковка готовых задач, резервы вывода и безопасности, жизненный цикл задач, NEED_MORE_CONTEXT и контролируемая эскалация.

removed/replaced control phases: обязательный Planner child удалён. Reviewer запускается как обычный worker с ролью `reviewer`; отдельный седьмой child не создаётся. Основной цикл DSH не переписывался.

# ORCHESTRATOR

separate Planner agent: NO. Родительский агент сам создаёт или проверяет граф; при отсутствии ручного графа используется минимальный детерминированный план.

solo context target: до примерно 110K только при подтверждённой физической feasibility; флаг размера сам по себе не считается доказательством.

maximum VERIFIED stable solo context: фактически выполнен prompt на 49 198 токенов при `--max-context 65536`, `--kv-capacity 81920`, `max-concurrency=1`; успешное заполнение 64K и больше не измерено. Поэтому безопасный production ceiling оставлен 65 536 логических токенов с обычным рабочим входом 48–56K.

working context policy: запрос проверяется до отправки, worker получает только пакет TASK/GOAL/RELEVANT CONTEXT/CONSTRAINTS/KNOWN FACTS/FILES/EXPECTED OUTPUT/DO NOT, а бюджет выбирается из фиксированных уровней по фактической потребности. Общий бюджет партии — 98 304 токена.

parking: состояние задачи хранится в результате и журнале DSH; `PARKED` не выставляется без подтверждённого кеша. Host KV и Responses continuation подтверждены только в пределах одного процесса.

# WORKERS

max logical workers: 6 children; вместе с одним родительским оркестратором это максимум 7 логических агентов.

context ceiling: 64K на worker.

dynamic tiers: 8 192, 16 384, 24 576, 32 768, 49 152 и 65 536 токенов.

compaction: PARTIAL. В протоколе есть сохранение точных фактов, открытых вопросов, ссылок на файлы и ограничений перед эскалацией, но отдельный длинный compaction benchmark ещё не выполнен.

NEED_MORE_CONTEXT: YES. Worker может вернуть `needs_more_context` и структурированный `NEED_MORE_CONTEXT`; слой добавляет минимальный материал и поднимает бюджет только до следующего уровня, максимум две повторные попытки.

# SCHEDULER

adaptive concurrency: PARTIAL. Resource Manager ограничивает обращения к модели двумя активными потоками; scheduler учитывает контекст, output reserve, safety reserve, общий бюджет, зависимости и конфликты записей. Автоматическое повышение до 3–6 пока не объявляется без измерений.

verified max concurrency for ~8K: не измерено; текущая безопасная политика — 2.

verified max concurrency for ~16K: не измерено; текущая безопасная политика — 2.

verified max concurrency for ~32K: не измерено; текущая безопасная политика — 2.

packing strategy: готовые задачи сортируются по убыванию стоимости и помещаются в жадную партию, пока не исчерпаны два слота, общий контекст или правила конфликтов записей; зависимые задачи ждут завершения предпосылок.

VRAM headroom policy: требуемый запас профиля — 0,8 GiB. При KV 80K после старта оставалось примерно 1,28 GiB, при KV 96K — около 799 MiB, при KV 110K — около 166 MiB; устойчивым считается только кандидат с запасом выше политики.

# 110K TEST

110K ACTIVE SEQUENCE VERIFIED: NO.

peak VRAM: при запуске пула KV 110K занято примерно 23 878 MiB из 24 576 MiB.

free VRAM: около 698 MiB после старта, что ниже целевого запаса.

prefill: успешный 110K prefill не измерен; стендовый запрос был отклонён по `context_length_exceeded` до генерации.

decode: не измерено для активной последовательности 110K.

TTFT: не измерено для активной последовательности 110K.

If NO:

maximum safe context: подтверждённый успешный длинный запрос — 49 198 prompt tokens при логическом пределе 65 536; отдельный точный safe maximum заполненного KV не установлен.

reason: пул 110K оставляет только около 698 MiB, а `/v1/models` сообщает предел 65 536; реальное заполнение 72–110K не прошло успешную генерацию. Называть 110K доступным нельзя.

# HOST CACHE

host KV actual purpose: исходный код и JSONL показывают отдельное Host KV/Host State хранилище для продолжений и неактивных состояний; оно не увеличивает доказанный Device KV ceiling для активной последовательности.

inactive continuation stored in RAM: YES, в пределах текущего процесса; в проверенном длинном логе Host KV occupancy достигал примерно 5 110 161 408 байт.

active KV can exceed device pool using RAM: NO, это доступными интерфейсами не подтверждено.

full prefill after restore: PARTIAL. В том же процессе cached continuation с 4 552 reused tokens дал TTFT около 0,23 с против примерно 4,79 с холодного запроса; после перезапуска прежний `previous_response_id` вернул HTTP 404, поэтому история DSH потребует повторной обработки.

8K restore: частичный same-process пример: запрос около 4 559 токенов, cached continuation около 4 552 токенов; точный 8K сценарий не измерен.

32K restore: не измерено.

64K restore: не измерено.

# SIX SMALL WORKERS

context each: не измерено на фиксированной реальной задаче; проектный бюджет выбирается динамически, а не резервируется заранее.

physical concurrency: не подтверждена выше 2. Шесть HTTP обращений ранее прошли через очередь при двух активных генерациях.

peak VRAM: отдельный тест шести малых workers не выполнен.

aggregate decode: не измерено.

per worker: не измерено.

total wall time: не измерено.

# COMPACTION TEST

active window: протокол сохраняет TASK, CHECKED/CONFIRMED факты, решения, открытые вопросы, ссылки на файлы и ограничения; отдельное заполнение длинного окна не запускалось.

total raw tokens processed: не измерено.

number of compactions: не измерено.

critical facts preserved: YES на уровне формата пакета и NEED_MORE_CONTEXT; количественная проверка на длинном контексте не выполнена.

# QUALITY TEST

single agent: объективное сравнение на заранее фиксированной задаче аудита не выполнено.

adaptive multi-agent: браузерный plan-only smoke после обновления пакета прошёл: родитель построил граф из researcher, backend и reviewer, `agentsStarted: 0`; у reviewer явно проверены `dependsOn` и совпадающие `taskPackage.dependencies`, изменений нет. Реальное read-only выполнение workers на одинаковой задаче ещё не сравнивалось.

objective differences: качество, полнота, противоречия, пропуски, время, токены и стоимость финального ответа не измерены.

# PRODUCTION RECOMMENDATION

Exact NInfer command:

```text
/home/diffusionlab/ninfer/ninfer-serve /home/diffusionlab/ninfer/models/qwen3_8_27b.ninfer --host 0.0.0.0 --port 8080 --max-context 65536 --kv-capacity 81920 --max-concurrency 2 --max-pending-requests 16 --prefill-chunk 1024 --kv-dtype int8 --vision --spec mtp --draft-tokens 3 --lm-head-draft --cors --model-id qwen3.8-27b --device-state-slots 2 --host-state-slots 8 --host-kv-mib 16384 --max-private-continuations 8 --max-shared-prefixes 8 --request-log-jsonl /home/diffusionlab/projects/dsh-task-orchestrator/bench/results/kv80-host16.server.jsonl
```

Exact DSH/profile config: `web-multiagent-3090` с `preferredWorkers: 2`, `maxWorkers: 6`, `maxTotalAgents: 6`, `maxConcurrentAgents: 2`, `maxActiveGenerations: 2`, `hardContextTokens: 65536`, `totalContextTokens: 98304`, `minimumVramHeadroomGiB: 0.8`, `parentOrchestratorOnly: true`.

maximum logical workers: 6 children плюс один родительский оркестратор.

physical concurrency policy: начинать с 2; переход к 3–6 разрешать только после отдельных стабильных benchmark для каждого диапазона контекста.

orchestrator context: логический предел 65 536, обычный вход 48–56K, с проверкой фактического размера до отправки.

worker context policy: выбирать минимальный уровень 8–64K по task package, сохранять точные факты и эскалировать только по обоснованному NEED_MORE_CONTEXT.

host RAM policy: 16 GiB Host KV остаётся кандидатом для неактивных продолжений внутри процесса; не считать его способом разместить активный 110K KV или пережить рестарт без повторного prefill.

# TESTS

pnpm check: PASS.

pnpm test: PASS, 12 tests.

pnpm build: PASS.

git diff --check: PASS.

Browser smoke: PASS через реальный профиль после перезапуска DSH. Видимый результат — `plan-only`, `agentsStarted: 0`, граф с researcher/backend/reviewer, явными зависимостями и пустыми `writeScopes`; рабочая папка не изменялась.

Runtime smoke: NInfer `/health` возвращает `{"status":"ok"}`; DSH отвечает на защищённый HTTP-порт (без токена получает `401`), оба процесса оставлены запущенными. Отдельное предупреждение `lingshu-bridge: spawn python ENOENT` устранено в профиле `web-multiagent-3090`: конфигурация `furongjun1999-dsh-memory` теперь явно использует существующий `/usr/bin/python3`. После перезапуска фактически запущен `/usr/bin/python3 -m md_cg.mcp_server`; новые ошибки `spawn python ENOENT` не появляются. Исходный patch профиля сохранён в `/home/diffusionlab/backups/dynamic-workers-3090-lingshu-20260916T123000Z/cordis.patch.yml.before`.

# ROLLBACK

Остановить только процессы кандидата DSH/NInfer, восстановить сохранённые файлы из `/home/diffusionlab/backups/dynamic-workers-3090-20260916T104739Z`, вернуть `/home/diffusionlab/.dsh/profiles/web-multiagent-3090/cordis.patch.yml` из `/home/diffusionlab/backups/dynamic-workers-3090-lingshu-20260916T123000Z/cordis.patch.yml.before`, переключить плагин на ветку `codex/dynamic-workers-3090`, затем запустить исходный NInfer с `--max-context 8192 --kv-capacity 16384 --max-concurrency 6 --kv-dtype int8` и прежний профиль `web`. Не удалять экспериментальную копию оркестратора внутри DSH.

# FINAL ANSWERS

1. Какой максимальный реальный solo context на RTX 3090? Подтверждён успешный prompt 49 198 токенов при логическом ceiling 65 536; точное заполнение 64K не измерено, поэтому production рекомендация остаётся 65 536 с обычным входом 48–56K.
2. Реальны ли 110K? Нет, не доказаны и не рекомендуются: пул оставляет около 698 MiB, а активная генерация 110K не прошла.
3. Могут ли 6 маленьких workers работать физически одновременно? Пока не подтверждено; проверенная политика и фактический предел — 2 активных запроса.
4. При каком context размере concurrency начинает снижаться? Граница 3–6 не измерена; текущая безопасная граница — 2 независимо от размера.
5. Как scheduler решает, кого запускать вместе? Берёт готовые задачи без незакрытых зависимостей, учитывает `context + output reserve + safety reserve`, два физических слота, общий бюджет 98 304, приоритет и конфликты записей, затем формирует жадную партию.
6. Работает ли RAM parking без полного prefill? В одном процессе продолжение частично переиспользует кеш; после рестарта Responses id теряется и доступен только повторный prefill из истории DSH. Полное RAM parking без prefill не подтверждено.
7. Сколько RAM реально используется? В одном длинном логе Host KV occupancy — примерно 5,11 GB; отдельные pinned RAM counters не выделены, Mlocked/Unevictable были по 16 KiB.
8. Какой production NInfer config оптимален? `max-context 65536`, `kv-capacity 81920`, INT8 KV, vision/MTP, два active streams, device state 2, host state 8 и Host KV 16 GiB; оставлено примерно 1,45–1,50 GiB VRAM после старта.
9. Насколько adaptive multi-agent быстрее/медленнее одного агента? Не измерено; заявлять ускорение нельзя.
10. В каких задачах adaptive multi-agent дал объективно лучший результат? Объективное качество на фиксированной задаче ещё не сравнивалось. Проверен только plan-only путь построения графа.
