🌐 [English](README.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md) | **한국어**

> [!NOTE]
> 이 번역은 AI의 도움을 받아 작성되었습니다. 부자연스러운 표현이나 오역을 발견하시면 Issue 또는 Pull Request로 알려주세요. 커뮤니티의 수정과 기여를 환영합니다.

# 🧠 Obsidian Mind

[![Claude Code](https://img.shields.io/badge/claude%20code-required-D97706)](https://docs.anthropic.com/en/docs/claude-code)
[![Obsidian](https://img.shields.io/badge/obsidian-1.12%2B-7C3AED)](https://obsidian.md)
[![Python](https://img.shields.io/badge/python-3.8%2B-3776AB)](https://python.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Claude Code가 모든 것을 기억하게 해주는 Obsidian 볼트.** 세션을 시작하고 하루에 대해 이야기하면, Claude가 나머지를 처리합니다 — 노트, 링크, 인덱스, 성과 추적까지. 모든 대화가 이전 대화 위에 쌓입니다.

---

## 🔴 문제

Claude Code는 강력하지만 기억하지 못합니다. 매 세션이 제로에서 시작됩니다 — 당신의 목표, 팀, 패턴, 성과에 대한 컨텍스트가 없습니다. 같은 내용을 반복해서 설명해야 합니다. 세 번의 대화 전에 내린 결정이 사라집니다. 지식이 축적되지 않습니다.

## 🟢 해결책

Claude에게 뇌를 주세요.

```
You: "start session"
Claude: *reads North Star, checks active projects, scans recent memories*
Claude: "You're working on Project Alpha, blocked on the BE contract.
         Last session you decided to split the coordinator. Your 1:1
         with your manager is tomorrow — review brief is ready."
```

---

## ⚡ 실제 동작 예시

**아침 킥오프:**

```bash
/standup
# → loads North Star, active projects, open tasks, recent git changes
# → "You have 2 active projects. The auth refactor is blocked on API contract.
#    Your 1:1 with Sarah is at 2pm — last time she flagged observability."
```

**회의 후 브레인 덤프:**

```bash
/dump Just had a 1:1 with Sarah. She's happy with the auth work but wants
us to add error monitoring before release. Also, Tom mentioned the cache
migration is deferred to Q2 — we decided to focus on the API contract first.
Decision: defer Redis migration. Win: Sarah praised the auth architecture.
```

```
→ Updated org/people/Sarah Chen.md with meeting context
→ Created work/1-1/Sarah 2026-03-26.md with key takeaways
→ Created Decision Record: "Defer Redis migration to Q2"
→ Added to perf/Brag Doc.md: "Auth architecture praised by manager"
→ Updated work/active/Auth Refactor.md with error monitoring task
```

**인시던트 대응:**

```bash
/incident-capture https://slack.com/archives/C0INCIDENT/p123456
# → slack-archaeologist reads every message, thread, and profile
# → people-profiler creates notes for new people involved
# → Full timeline, root cause analysis, brag doc entry
```

**하루 마무리:**

```
You: "wrap up"
# → verifies all notes have links
# → updates indexes
# → brag-spotter finds uncaptured wins
# → suggests improvements
```

---

## ⚙️ 작동 원리

**폴더는 용도별로 그룹화하고, 링크는 의미별로 그룹화합니다.** 노트는 하나의 폴더(본거지)에 있지만 여러 노트(컨텍스트)에 링크됩니다. Claude는 이 그래프를 유지 관리합니다 — 작업 노트를 사람, 의사결정, 역량에 자동으로 연결합니다. 리뷰 시즌이 오면 각 역량 노트의 백링크가 이미 증거 자료가 됩니다. 링크가 없는 노트는 버그입니다.

**볼트 우선 메모리**는 세션과 기기 간에 컨텍스트를 유지합니다. 모든 지속 지식은 `brain/` 토픽 노트에 있습니다(git 추적, Obsidian 브라우저 가능, 링크됨). Claude Code의 `MEMORY.md`(`~/.claude/`)는 볼트 위치를 가리키는 자동 로드 인덱스일 뿐 — 저장소 자체가 아닙니다. 즉, 메모리가 기기 변경에도 유지되며 그래프의 일부가 됩니다.

**세션은 설계된 생명주기를 따릅니다.** `SessionStart` 훅이 North Star 목표, 활성 프로젝트, 최근 변경사항, 미완료 작업, 전체 볼트 파일 목록을 자동 주입합니다 — Claude는 빈 상태가 아니라 컨텍스트가 있는 상태로 모든 세션을 시작합니다. 마무리할 때 "wrap up"이라고 말하면 Claude가 `/wrap-up`을 실행합니다 — 노트 검증, 인덱스 업데이트, 누락된 성과 발견. 285줄의 `CLAUDE.md`가 그 사이의 모든 것을 관리합니다: 파일 배치 위치, 링크 방법, 노트를 분할해야 할 때, 의사결정과 인시던트 처리 방법.

### 훅

다섯 개의 생명주기 훅이 라우팅을 자동으로 처리합니다:

| 훅 | 시점 | 동작 |
|------|------|------|
| 🚀 SessionStart | 시작/재개 시 | QMD 재인덱싱, North Star·활성 작업·최근 변경사항·작업·파일 목록 주입 |
| 💬 UserPromptSubmit | 매 메시지마다 | 콘텐츠 분류(의사결정, 인시던트, 성과, 1:1, 아키텍처, 인물) 및 라우팅 힌트 주입 |
| ✍️ PostToolUse | `.md` 작성 후 | 프론트매터 유효성 검사, 위키링크 확인, 폴더 배치 검증 |
| 💾 PreCompact | 컨텍스트 압축 전 | 세션 트랜스크립트를 `thinking/session-logs/`에 백업 |
| 🏁 Stop | 세션 종료 시 | 체크리스트: 완료된 프로젝트 아카이브, 인덱스 업데이트, 고아 노트 확인 |

> [!TIP]
> 그냥 이야기하세요. 훅이 라우팅을 처리합니다.

---

## 📅 일일 워크플로우

**아침**: `/standup`을 실행합니다. Claude가 North Star, 활성 프로젝트, 미완료 작업, 최근 변경사항을 로드합니다. 구조화된 요약과 추천 우선순위를 받습니다.

**하루 중**: 자연스럽게 이야기하세요. 내린 결정, 발생한 인시던트, 방금 마친 1:1, 기억하고 싶은 성과를 언급하세요. 분류 훅이 Claude가 각 항목을 올바르게 기록하도록 안내합니다. 더 큰 브레인 덤프를 하려면 `/dump`을 사용하고 한 번에 모든 것을 이야기하세요.

**하루 끝**: "wrap up"이라고 말하면 Claude가 `/wrap-up`을 호출합니다 — 노트 검증, 인덱스 업데이트, 링크 확인, 누락된 성과 발견.

**주간**: `/weekly`를 실행하여 세션 간 종합 분석 — North Star 정렬, 패턴, 누락된 성과, 다음 주 우선순위. `/vault-audit`를 실행하여 고아 노트, 깨진 링크, 오래된 콘텐츠를 점검합니다.

**리뷰 시즌**: `/review-brief manager`를 실행하면 모든 증거가 이미 링크된 구조화된 리뷰 준비 문서를 받습니다.

---

## 🛠️ 명령어

`.claude/commands/`에 정의되어 있습니다. 모든 Claude Code 세션에서 실행할 수 있습니다.

| 명령어 | 기능 |
|---------|-------------|
| `/standup` | 아침 킥오프 — 컨텍스트 로드, 어제 리뷰, 작업 표면화, 우선순위 제안 |
| `/dump` | 자유 형식 캡처 — 무엇이든 자연스럽게 이야기하면 Claude가 올바른 노트로 라우팅 |
| `/wrap-up` | 전체 세션 리뷰 — 노트, 인덱스, 링크 검증, 개선사항 제안 |
| `/humanize` | 목소리 보정 편집 — Claude가 작성한 텍스트를 본인이 쓴 것처럼 수정 |
| `/weekly` | 주간 종합 — 세션 간 패턴, North Star 정렬, 누락된 성과 |
| `/capture-1on1` | 1:1 미팅 트랜스크립트를 구조화된 볼트 노트로 캡처 |
| `/incident-capture` | Slack/채널의 인시던트를 구조화된 노트로 캡처 |
| `/slack-scan` | Slack 채널/DM을 깊이 스캔하여 증거 수집 |
| `/peer-scan` | 동료의 GitHub PR을 깊이 스캔하여 리뷰 준비 |
| `/review-brief` | 리뷰 브리프 생성 (매니저 또는 동료 버전) |
| `/self-review` | 리뷰 시즌을 위한 자기 평가 작성 — 프로젝트, 역량, 원칙 |
| `/review-peer` | 동료 리뷰 작성 — 프로젝트, 원칙, 성과 요약 |
| `/vault-audit` | 인덱스, 링크, 고아 노트, 오래된 컨텍스트 감사 |
| `/vault-upgrade` | 기존 볼트에서 콘텐츠 가져오기 — 버전 감지, 분류, 마이그레이션 |
| `/project-archive` | 완료된 프로젝트를 active/에서 archive/로 이동, 인덱스 업데이트 |

---

## 🤖 서브에이전트

격리된 컨텍스트 윈도우에서 실행되는 전문 에이전트입니다. 메인 대화를 오염시키지 않고 무거운 작업을 처리합니다.

| 에이전트 | 용도 | 호출 방법 |
|-------|---------|------------|
| `brag-spotter` | 누락된 성과와 역량 격차 발견 | `/wrap-up`, `/weekly` |
| `context-loader` | 인물, 프로젝트, 개념에 대한 모든 볼트 컨텍스트 로드 | 직접 호출 |
| `cross-linker` | 누락된 위키링크, 고아 노트, 깨진 백링크 발견 | `/vault-audit` |
| `people-profiler` | Slack 프로필에서 인물 노트를 일괄 생성/업데이트 | `/incident-capture` |
| `review-prep` | 리뷰 기간의 모든 성과 증거 집계 | `/review-brief` |
| `slack-archaeologist` | 전체 Slack 복원 — 모든 메시지, 스레드, 프로필 | `/incident-capture` |
| `vault-librarian` | 심층 볼트 유지보수 — 고아 노트, 깨진 링크, 오래된 노트 | `/vault-audit` |
| `review-fact-checker` | 리뷰 초안의 모든 주장을 볼트 소스와 대조 검증 | `/self-review`, `/review-peer` |
| `vault-migrator` | 소스 볼트에서 콘텐츠 분류, 변환, 마이그레이션 | `/vault-upgrade` |

> [!NOTE]
> 서브에이전트는 `.claude/agents/`에 정의되어 있습니다. 도메인별 워크플로우를 위해 직접 추가할 수 있습니다.

---

## 📊 성과 그래프

볼트는 성과 추적 시스템으로도 활용됩니다:

1. **역량 노트**(`perf/competencies/`)가 조직의 역량 프레임워크를 정의합니다 — 역량별로 하나의 노트
2. **작업 노트**가 `## Related` 섹션에서 역량에 링크하며, 어떤 역량이 발휘되었는지 주석을 답니다
3. **백링크가 자동으로 축적됩니다** — 리뷰 준비는 각 역량 노트의 백링크 패널을 읽는 것으로 충분합니다
4. **Brag Doc**가 분기별 성과를 증거 노트 링크와 함께 집계합니다
5. **`/peer-scan`**이 동료의 GitHub PR을 깊이 스캔하고 구조화된 증거를 `perf/evidence/`에 작성합니다
6. **`/review-brief`**가 모든 것을 집계하여 전체 리뷰 브리프를 생성합니다: Brag 항목, 의사결정, 인시던트, 역량 증거, 1:1 피드백

> [!TIP]
> 시작하려면: 템플릿에서 역량 노트를 만들고, 작업하면서 작업 노트에 역량을 링크하세요. 그래프가 나머지를 처리합니다.

---

## 📋 Bases

`bases/` 폴더에는 노트의 프론트매터 속성을 쿼리하는 데이터베이스 뷰가 있습니다. 노트가 변경되면 자동으로 업데이트됩니다.

| Base | 표시 내용 |
|------|-------|
| Work Dashboard | 분기별 필터링, 상태별 그룹화된 활성 프로젝트 |
| Incidents | 심각도와 날짜순으로 정렬된 모든 인시던트 |
| People Directory | `org/people/`의 모든 인물과 역할, 팀 정보 |
| 1:1 History | 인물과 날짜로 정렬 가능한 모든 1:1 노트 |
| Review Evidence | 인물과 주기별로 그룹화된 PR 스캔 및 증거 |
| Competency Map | 백링크 기반 증거 수를 포함한 역량 목록 |
| Templates | 모든 템플릿에 대한 빠른 접근 |

`Home.md`가 이 뷰들을 임베드하여 볼트의 대시보드 역할을 합니다.

---

## 🔄 업그레이드

이전 버전의 obsidian-mind(또는 기존 Obsidian 볼트)를 사용 중이신가요? `/vault-upgrade` 명령어가 최신 템플릿으로 콘텐츠를 마이그레이션합니다:

```bash
# 1. Clone the latest obsidian-mind
git clone https://github.com/breferrari/obsidian-mind.git ~/new-vault

# 2. Open it in Claude Code
cd ~/new-vault && claude

# 3. Run the upgrade pointing to your old vault
/vault-upgrade ~/my-old-vault
```

Claude가 수행하는 작업:
1. **감지** — 볼트 버전 확인 (v1–v3.2, 또는 obsidian-mind가 아닌 볼트 식별)
2. **인벤토리** — 모든 파일을 사용자 콘텐츠, 스캐폴드, 인프라, 미분류로 분류
3. **마이그레이션 계획 제시** — 복사, 변환, 건너뛸 항목을 정확히 보여줌
4. **승인 후 실행** — 프론트매터 변환, 위키링크 수정, 인덱스 재구축
5. **검증** — 고아 노트, 깨진 링크, 누락된 프론트매터 확인

기존 볼트는 **절대 수정되지 않습니다**. `--dry-run`을 사용하면 실행 없이 계획만 미리 볼 수 있습니다.

> [!NOTE]
> obsidian-mind뿐만 아니라 모든 Obsidian 볼트에서 작동합니다. obsidian-mind가 아닌 볼트의 경우, Claude가 각 노트를 읽고 의미적으로 분류합니다 — 작업 노트, 인물, 인시던트, 1:1, 의사결정을 올바른 폴더로 라우팅합니다.

---

## 🚀 빠른 시작

1. 이 저장소를 클론하거나 **GitHub 템플릿**으로 사용하세요
2. 폴더를 **Obsidian 볼트**로 엽니다
3. 설정 → 일반에서 **Obsidian CLI**를 활성화합니다 (Obsidian 1.12+ 필요)
4. 볼트 디렉토리에서 **`claude`**를 실행합니다
5. **`brain/North Star.md`**에 목표를 작성합니다 — 이것이 모든 세션의 기준이 됩니다
6. 업무에 대해 이야기를 시작하세요

### 선택 사항: QMD 시맨틱 검색

볼트 전체의 시맨틱 검색을 위해 (노트 제목이 "Redis Migration ADR"이어도 "캐싱에 대해 뭘 결정했지?"를 찾을 수 있습니다):

```bash
npm install -g @tobilu/qmd
qmd collection add . --name vault --mask "**/*.md"
qmd context add qmd://vault "Engineer's work vault: projects, decisions, incidents, people, reviews, architecture"
qmd update && qmd embed
```

> [!NOTE]
> QMD가 설치되어 있지 않아도 모든 기능이 작동합니다 — Claude가 Obsidian CLI와 grep으로 대체합니다.

---

## 📁 볼트 구조

```
Home.md                 볼트 진입점 — 임베드된 Base 뷰, 바로가기 링크
CLAUDE.md               운영 매뉴얼 — Claude가 매 세션마다 읽음
vault-manifest.json     템플릿 메타데이터 — 버전, 구조, 스키마
CHANGELOG.md            버전 히스토리
CONTRIBUTING.md         템플릿 개발 체크리스트
README.md               제품 문서
LICENSE                 MIT 라이선스

bases/                  동적 데이터베이스 뷰 (Work Dashboard, Incidents, People 등)

work/
  active/               현재 프로젝트 (한 번에 1–3개 파일)
  archive/YYYY/         완료된 작업, 연도별 정리
  incidents/            인시던트 문서 (메인 노트 + RCA + 심층 분석)
  1-1/                  1:1 미팅 노트 — <Person> YYYY-MM-DD.md 형식
  Index.md              모든 작업의 Map of Content

org/
  people/               인물별 노트 — 역할, 팀, 관계, 주요 순간
  teams/                팀별 노트 — 구성원, 범위, 상호작용
  People & Context.md   조직 지식의 MOC

perf/
  Brag Doc.md           증거에 링크된 성과 기록
  brag/                 분기별 Brag 노트 (분기당 하나)
  competencies/         역량별 노트 (링크 대상)
  evidence/             PR 심층 스캔, 리뷰용 데이터 추출
  <cycle>/              리뷰 주기별 브리프 및 산출물

brain/
  North Star.md         목표와 집중 영역 — 매 세션마다 읽음
  Memories.md           메모리 토픽 인덱스
  Key Decisions.md      중요한 의사결정과 근거
  Patterns.md           작업 전반에서 관찰된 반복 패턴
  Gotchas.md            잘못된 것들과 그 이유
  Skills.md             커스텀 워크플로우와 슬래시 명령어

reference/              코드베이스 지식, 아키텍처 맵, 플로우 문서
thinking/               초안을 위한 스크래치패드 — 결과 정리 후 삭제
templates/              YAML 프론트매터가 포함된 Obsidian 템플릿

.claude/
  commands/             15개 슬래시 명령어
  agents/               9개 서브에이전트
  scripts/              훅 스크립트 + charcount.sh 유틸리티
  skills/               Obsidian + QMD 스킬
  settings.json         5개 훅 설정
```

---

## 📝 템플릿

YAML 프론트매터가 포함된 템플릿으로, 각각 점진적 공개를 위한 `description` 필드를 포함합니다:

- **Work Note** — 날짜, 설명, 프로젝트, 상태, 분기, 태그
- **Decision Record** — 날짜, 설명, 상태 (proposed/accepted/deprecated), 담당자, 맥락
- **Thinking Note** — 날짜, 설명, 맥락, 태그 (스크래치패드 — 정리 후 삭제)
- **Competency Note** — 날짜, 설명, 현재 레벨, 목표 레벨, 숙련도 표
- **1:1 Note** — 날짜, 상대방, 핵심 요점, 액션 아이템, 인용, 주시 사항
- **Incident Note** — 날짜, 티켓, 심각도, 역할, 타임라인, 근본 원인, 영향

---

## 🔧 포함 항목

### Obsidian 스킬

[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)가 `.claude/skills/`에 사전 설치되어 있습니다:

- **obsidian-markdown** — Obsidian 특화 마크다운 (위키링크, 임베드, 콜아웃, 속성)
- **obsidian-cli** — 볼트 운영을 위한 CLI 명령어
- **obsidian-bases** — 데이터베이스 스타일 `.base` 파일
- **json-canvas** — 시각적 `.canvas` 파일 생성
- **defuddle** — 웹 페이지를 마크다운으로 추출

### QMD 스킬

`.claude/skills/qmd/`에 있는 커스텀 스킬로, Claude가 [QMD](https://github.com/tobi/qmd) 시맨틱 검색을 능동적으로 사용하도록 합니다 — 파일을 읽기 전, 노트 생성 전(중복 확인), 노트 생성 후(링크할 관련 콘텐츠 탐색).

---

## 🎨 커스터마이즈

이것은 출발점입니다. 자신의 업무 방식에 맞게 조정하세요:

| 항목 | 위치 |
|------|-------|
| 목표 | `brain/North Star.md` — 모든 세션의 기준 |
| 조직 | `org/` — 매니저, 팀, 핵심 협력자 추가 |
| 역량 | `perf/competencies/` — 조직의 프레임워크에 맞추기 |
| 도구 | `.claude/commands/` — GitHub 조직, Slack 워크스페이스에 맞게 편집 |
| 규칙 | `CLAUDE.md` — 운영 매뉴얼, 진행하면서 발전시키기 |
| 도메인 | 폴더 추가, `.claude/agents/`에 서브에이전트 추가, `.claude/scripts/`에 분류 규칙 추가 |

> [!IMPORTANT]
> `CLAUDE.md`는 운영 매뉴얼입니다. 규칙을 변경하면 이 파일을 업데이트하세요 — Claude가 매 세션마다 읽습니다.

---

## 📋 요구 사항

- [Obsidian](https://obsidian.md) 1.12+ (CLI 지원)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- Python 3 (훅 스크립트용)
- Git (버전 히스토리용)
- [QMD](https://github.com/tobi/qmd) (선택 사항, 시맨틱 검색용)

---

## 🙏 디자인 영향

- [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) — 공식 Obsidian 에이전트 스킬
- [James Bedford](https://x.com/jameesy) — 볼트 구조 철학, AI 생성 콘텐츠 분리
- [arscontexta](https://github.com/agenticnotetaking/arscontexta) — description 필드를 통한 점진적 공개, 세션 훅

---

## 📄 라이선스

MIT
