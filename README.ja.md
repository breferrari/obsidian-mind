🌐 [English](README.md) | **日本語** | [中文](README.zh-CN.md) | [한국어](README.ko.md)

> [!NOTE]
> この翻訳はAIの支援を受けて作成されました。不自然な表現や誤訳がありましたら、ぜひIssueやPull Requestでお知らせください。コミュニティからの修正を歓迎します。

# 🧠 Obsidian Mind

[![Claude Code](https://img.shields.io/badge/claude%20code-required-D97706)](https://docs.anthropic.com/en/docs/claude-code)
[![Obsidian](https://img.shields.io/badge/obsidian-1.12%2B-7C3AED)](https://obsidian.md)
[![Python](https://img.shields.io/badge/python-3.8%2B-3776AB)](https://python.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Claude Codeにすべてを記憶させるObsidianボールト。** セッションを開始して、日々のことを話すだけ — ノート、リンク、インデックス、パフォーマンス管理はClaudeが自動で処理します。すべての会話が前回の続きとして積み重なっていきます。

---

## 🔴 課題

Claude Codeは強力ですが、忘れてしまいます。毎回のセッションがゼロからの出発 — あなたの目標、チーム、パターン、実績に関するコンテキストがありません。同じことを何度も説明し直し、3回前の会話で下した決定が失われます。知識が蓄積されないのです。

## 🟢 解決策

Claudeに脳を与えましょう。

```
あなた: "セッション開始"
Claude: *North Starを読み、アクティブなプロジェクトを確認し、最近の記憶をスキャン*
Claude: "Project Alphaに取り組んでいますね。BEコントラクトでブロック中です。
         前回のセッションでコーディネーターを分割することに決めましたね。
         明日マネージャーとの1on1があります — レビューブリーフは準備完了です。"
```

---

## ⚡ 実際の動作

<p align="center">
  <img src="obsidian-mind-demo.gif" alt="Obsidian Mind デモ — standup と dump コマンド" width="800">
</p>

**朝のキックオフ:**

```bash
/om-standup
# → North Star、アクティブプロジェクト、未完了タスク、最近のgit変更を読み込み
# → "アクティブなプロジェクトが2つあります。認証リファクタリングはAPIコントラクト待ちです。
#    14時にSarahとの1on1があります — 前回、オブザーバビリティについて指摘がありました。"
```

**ミーティング後のブレインダンプ:**

```bash
/om-dump Just had a 1:1 with Sarah. She's happy with the auth work but wants
us to add error monitoring before release. Also, Tom mentioned the cache
migration is deferred to Q2 — we decided to focus on the API contract first.
Decision: defer Redis migration. Win: Sarah praised the auth architecture.
```

```
→ org/people/Sarah Chen.md をミーティングの内容で更新
→ work/1-1/Sarah 2026-03-26.md を作成（要点まとめ付き）
→ Decision Record を作成: 「RedisマイグレーションをQ2に延期」
→ perf/Brag Doc.md に追加: 「マネージャーから認証アーキテクチャを評価された」
→ work/active/Auth Refactor.md にエラーモニタリングタスクを追加
```

**インシデント対応:**

```bash
/om-incident-capture https://slack.com/archives/C0INCIDENT/p123456
# → slack-archaeologist がすべてのメッセージ、スレッド、プロフィールを読み取り
# → people-profiler が関係者のノートを作成
# → 完全なタイムライン、根本原因分析、Brag Docへのエントリー
```

**一日の終わり:**

```
あなた: "wrap up"
# → すべてのノートにリンクがあるか確認
# → インデックスを更新
# → brag-spotter が記録されていない実績を発見
# → 改善点を提案
```

---

## 🚀 クイックスタート

1. このリポジトリをクローン（または**GitHubテンプレート**として使用）
2. フォルダを**Obsidianボールト**として開く
3. 設定 → 一般で**Obsidian CLI**を有効化（Obsidian 1.12以上が必要）
4. ボールトディレクトリで**`claude`**を実行
5. **`brain/North Star.md`**に目標を記入 — これがすべてのセッションの基盤になります
6. 仕事について話し始める

### オプション：QMDセマンティック検索

ボールト全体のセマンティック検索（ノートのタイトルが「Redis Migration ADR」でも「キャッシュについて何を決めた？」で見つかる）：

```bash
npm install -g @tobilu/qmd
qmd collection add . --name vault --mask "**/*.md"
qmd context add qmd://vault "Engineer's work vault: projects, decisions, incidents, people, reviews, architecture"
qmd update && qmd embed
```

> [!NOTE]
> QMDがインストールされていなくても、すべて動作します — ClaudeはObsidian CLIとgrepにフォールバックします。

---

## 📋 要件

- [Obsidian](https://obsidian.md) 1.12以上（CLIサポートのため）
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- Python 3（フックスクリプト用）
- Git（バージョン履歴用）
- [QMD](https://github.com/tobi/qmd)（オプション、セマンティック検索用）

---

## ⚙️ 仕組み

**フォルダは目的別にグループ化。リンクは意味別にグループ化。** ノートは1つのフォルダ（その居場所）に存在しますが、多くのノート（そのコンテキスト）にリンクします。Claudeがこのグラフを維持し、作業ノートを人物、意思決定、コンピテンシーに自動的にリンクします。レビューシーズンが来たとき、各コンピテンシーノートのバックリンクがそのままエビデンスの軌跡になっています。リンクのないノートはバグです。

**ボールトファーストのメモリ**がセッション間・マシン間でコンテキストを保持します。永続的な知識はすべて`brain/`のトピックノート（git管理、Obsidianで閲覧可能、リンク付き）に保存されます。Claude Codeの`MEMORY.md`（`~/.claude/`）はボールト内の場所を指す自動読み込みインデックスであり、ストレージそのものではありません。これにより、記憶はマシン変更後も生き残り、グラフの一部として機能します。

**セッションには設計されたライフサイクルがあります。** `SessionStart`フックが自動的にNorth Starの目標、アクティブプロジェクト、最近の変更、未完了タスク、ボールト全体のファイル一覧を注入します — Claudeは白紙からではなく、コンテキストを持ってセッションを開始します。終了時に「wrap up」と言えば、Claudeが`/om-wrap-up`を実行 — ノートの検証、インデックスの更新、記録漏れの実績の発見を行います。285行の`CLAUDE.md`がその間のすべてを統制します：ファイルの配置場所、リンクの仕方、ノートの分割タイミング、意思決定やインシデントの扱い方。

### フック

5つのライフサイクルフックが自動的にルーティングを処理します：

| フック | タイミング | 内容 |
|------|------|------|
| 🚀 SessionStart | 起動/再開時 | QMD再インデックス、North Star・アクティブプロジェクト・最近の変更・タスク・ファイル一覧を注入 |
| 💬 UserPromptSubmit | 全メッセージ | コンテンツを分類（意思決定、インシデント、実績、1on1、アーキテクチャ、人物）してルーティングヒントを注入 |
| ✍️ PostToolUse | `.md`書き込み後 | フロントマターの検証、ウィキリンクの確認、フォルダ配置の検証 |
| 💾 PreCompact | コンテキスト圧縮前 | セッション記録を`thinking/session-logs/`にバックアップ |
| 🏁 Stop | セッション終了時 | チェックリスト：完了プロジェクトのアーカイブ、インデックス更新、孤立ノートの確認 |

> [!TIP]
> ただ話すだけ。フックがルーティングを処理します。

---

## 📅 日常ワークフロー

**朝**: `/om-standup`を実行。ClaudeがNorth Star、アクティブプロジェクト、未完了タスク、最近の変更を読み込みます。構造化されたサマリーと優先度の提案が表示されます。

**日中**: 自然に話しましょう。下した決定、発生したインシデント、終わったばかりの1on1、覚えておきたい実績を伝えてください。分類フックがClaudeに各情報を正しく整理するよう促します。まとめてダンプしたい場合は`/om-dump`を使い、すべてを一度に語ってください。

**終業時**: 「wrap up」と言えば、Claudeが`/om-wrap-up`を呼び出します — ノートの検証、インデックスの更新、リンクの確認、記録漏れの実績の発見を行います。

**週次**: `/om-weekly`を実行してセッション横断の振り返り — North Starとの整合性確認、パターンの発見、記録漏れの実績、翌週の優先事項。`/om-vault-audit`を実行して孤立ノート、壊れたリンク、古くなったコンテンツを検出します。

**レビューシーズン**: `/om-review-brief manager`を実行すれば、エビデンスがすべてリンクされた構造化レビュー準備ドキュメントが生成されます。

---

## 🛠️ コマンド

`.claude/commands/`で定義されています。任意のClaude Codeセッションで実行できます。

| コマンド | 機能 |
|---------|------|
| `/om-standup` | 朝のキックオフ — コンテキスト読み込み、前日の振り返り、タスクの表示、優先度の提案 |
| `/om-dump` | フリーフォームキャプチャ — 何でも自然に話せば、Claudeが適切なノートに振り分け |
| `/om-wrap-up` | セッション全体のレビュー — ノート、インデックス、リンクの検証、改善点の提案 |
| `/om-humanize` | 文体の調整 — Claudeが書いたテキストをあなたが書いたように修正 |
| `/om-weekly` | 週次振り返り — セッション横断のパターン、North Starとの整合性、記録漏れの実績 |
| `/om-prep-1on1` | 1on1の準備 — 相手のコンテキスト、未解決事項、提案アジェンダを読み込み |
| `/om-meeting` | トピック別ミーティング準備 — 未解決事項、ブロッカー、考慮すべきポイントを整理 |
| `/om-intake` | ミーティングノート受信箱を処理 — `work/meetings/`のファイルを分類して適切なノートに振り分け |
| `/om-capture-1on1` | 1on1ミーティングのトランスクリプトを構造化ボールトノートとしてキャプチャ |
| `/om-incident-capture` | Slack/チャンネルからインシデントを構造化ノートとしてキャプチャ |
| `/om-slack-scan` | Slackチャンネル/DMをエビデンス収集のためにディープスキャン |
| `/om-peer-scan` | レビュー準備のために同僚のGitHub PRをディープスキャン |
| `/om-review-brief` | レビューブリーフを生成（マネージャー版またはピア版） |
| `/om-self-review` | レビューシーズン用の自己評価を作成 — プロジェクト、コンピテンシー、原則 |
| `/om-review-peer` | ピアレビューを作成 — プロジェクト、原則、パフォーマンスサマリー |
| `/om-vault-audit` | インデックス、リンク、孤立ノート、古いコンテキストを監査 |
| `/om-vault-upgrade` | 既存ボールトからコンテンツをインポート — バージョン検出、分類、移行 |
| `/om-project-archive` | 完了プロジェクトをactive/からarchive/に移動し、インデックスを更新 |

---

## 🤖 サブエージェント

分離されたコンテキストウィンドウで実行される専門エージェント。メインの会話を汚さずに重い処理を担当します。

| エージェント | 目的 | 呼び出し元 |
|------------|------|------------|
| `brag-spotter` | 記録漏れの実績やコンピテンシーギャップを発見 | `/om-wrap-up`, `/om-weekly` |
| `context-loader` | 人物、プロジェクト、コンセプトに関するボールトコンテキストをすべて読み込み | 直接呼び出し |
| `cross-linker` | 不足しているウィキリンク、孤立ノート、壊れたバックリンクを発見 | `/om-vault-audit` |
| `people-profiler` | Slackプロフィールから人物ノートを一括作成/更新 | `/om-incident-capture` |
| `review-prep` | レビュー期間のパフォーマンスエビデンスをすべて集約 | `/om-review-brief` |
| `slack-archaeologist` | Slackの完全な復元 — すべてのメッセージ、スレッド、プロフィール | `/om-incident-capture` |
| `vault-librarian` | ボールトの徹底メンテナンス — 孤立ノート、壊れたリンク、古いノート | `/om-vault-audit` |
| `review-fact-checker` | レビュー原稿のすべての主張をボールトのソースと照合して検証 | `/om-self-review`, `/om-review-peer` |
| `vault-migrator` | ソースボールトからコンテンツを分類、変換、移行 | `/om-vault-upgrade` |

> [!NOTE]
> サブエージェントは`.claude/agents/`で定義されています。ドメイン固有のワークフロー用に独自のエージェントを追加できます。

---

## 📊 パフォーマンスグラフ

ボールトはパフォーマンス追跡システムとしても機能します：

1. **コンピテンシーノート**（`perf/competencies/`）が組織のコンピテンシーフレームワークを定義 — コンピテンシーごとに1つのノート
2. **作業ノート**が`## Related`セクションでコンピテンシーにリンクし、何を実証したかを注記
3. **バックリンクが自動的に蓄積** — レビュー準備は各コンピテンシーノートのバックリンクパネルを読むだけ
4. **Brag Doc**が四半期ごとの実績をエビデンスノートへのリンク付きで集約
5. **`/om-peer-scan`**が同僚のGitHub PRをディープスキャンし、構造化されたエビデンスを`perf/evidence/`に記録
6. **`/om-review-brief`**がすべてを集約して完全なレビューブリーフを生成：Bragエントリー、意思決定、インシデント、コンピテンシーエビデンス、1on1フィードバック

> [!TIP]
> 始め方：テンプレートからコンピテンシーノートを作成し、作業を進めながら作業ノートをリンクしていくだけ。あとはグラフが処理します。

---

## 📋 Bases

`bases/`フォルダには、ノートのフロントマタープロパティを検索するデータベースビューが格納されています。ノートが変更されると自動的に更新されます。

| Base | 表示内容 |
|------|---------|
| Work Dashboard | 四半期でフィルタリングされ、ステータスでグループ化されたアクティブプロジェクト |
| Incidents | 重要度と日付で並べ替えられた全インシデント |
| People Directory | `org/people/`の全員（役割、チーム付き） |
| 1:1 History | 人物と日付でソート可能な全1on1ノート |
| Review Evidence | 人物とサイクルでグループ化されたPRスキャンとエビデンス |
| Competency Map | バックリンクからのエビデンス数付きコンピテンシー一覧 |
| Templates | 全テンプレートへのクイックアクセス |

`Home.md`がこれらのビューを埋め込んでおり、ボールトのダッシュボードとして機能します。

---

## 📁 ボールト構造

```
Home.md                 ボールトのエントリーポイント — 埋め込みBaseビュー、クイックリンク
CLAUDE.md               運用マニュアル — Claudeが毎セッション読み込み
vault-manifest.json     テンプレートメタデータ — バージョン、構造、スキーマ
CHANGELOG.md            バージョン履歴
CONTRIBUTING.md         テンプレート開発チェックリスト
README.md               プロダクトドキュメント
LICENSE                 MITライセンス

bases/                  動的データベースビュー（Work Dashboard、Incidents、Peopleなど）

work/
  active/               現在のプロジェクト（常時1〜3ファイル）
  archive/YYYY/         完了した作業（年別に整理）
  incidents/            インシデントドキュメント（メインノート + RCA + ディープダイブ）
  1-1/                  1on1ミーティングノート — <人名> YYYY-MM-DD.md
  Index.md              全作業のMap of Content

org/
  people/               人物ごとに1ノート — 役割、チーム、関係性、重要な出来事
  teams/                チームごとに1ノート — メンバー、スコープ、関わり
  People & Context.md   組織知識のMOC

perf/
  Brag Doc.md           実績の継続記録（エビデンスへのリンク付き）
  brag/                 四半期ごとのBragノート（各四半期1つ）
  competencies/         コンピテンシーごとに1ノート（リンクターゲット）
  evidence/             PRディープスキャン、レビュー用データ抽出
  <cycle>/              レビューサイクルのブリーフとアーティファクト

brain/
  North Star.md         目標とフォーカスエリア — 毎セッション読み込み
  Memories.md           記憶トピックのインデックス
  Key Decisions.md      重要な意思決定とその理由
  Patterns.md           作業全体で観察された繰り返しパターン
  Gotchas.md            うまくいかなかったことその理由
  Skills.md             カスタムワークフローとスラッシュコマンド

reference/              コードベースの知識、アーキテクチャマップ、フロードキュメント
thinking/               ドラフト用スクラッチパッド — 知見を昇格させたら削除
templates/              YAMLフロントマター付きObsidianテンプレート

.claude/
  commands/             18個のスラッシュコマンド
  agents/               9個のサブエージェント
  scripts/              フックスクリプト + charcount.shユーティリティ
  skills/               Obsidian + QMDスキル
  settings.json         5つのフック設定
```

---

## 📝 テンプレート

YAMLフロントマター付きテンプレート。段階的開示のための`description`フィールドを含みます：

- **Work Note** — date、description、project、status、quarter、tags
- **Decision Record** — date、description、status（proposed/accepted/deprecated）、owner、context
- **Thinking Note** — date、description、context、tags（スクラッチパッド — 昇格後に削除）
- **Competency Note** — date、description、current-level、target-level、proficiency table
- **1:1 Note** — date、person、key takeaways、action items、quotes
- **Incident Note** — date、ticket、severity、role、timeline、root cause、impact

---

## 🔧 同梱内容

### Obsidianスキル

[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)が`.claude/skills/`にプリインストール済み：

- **obsidian-markdown** — Obsidianフレーバーのmarkdown（ウィキリンク、埋め込み、コールアウト、プロパティ）
- **obsidian-cli** — ボールト操作用CLIコマンド
- **obsidian-bases** — データベーススタイルの`.base`ファイル
- **json-canvas** — ビジュアル`.canvas`ファイル作成
- **defuddle** — WebページからMarkdownへの変換

### QMDスキル

`.claude/skills/qmd/`にあるカスタムスキル。Claudeに[QMD](https://github.com/tobi/qmd)セマンティック検索を積極的に活用するよう教えます — ファイルを読む前、ノートを作成する前（重複チェック）、ノートを作成した後（リンクすべき関連コンテンツの発見）に使用します。

---

## 🎨 カスタマイズ

これは出発点です。あなたの働き方に合わせて適応させてください：

| 対象 | 場所 |
|------|------|
| あなたの目標 | `brain/North Star.md` — すべてのセッションの基盤 |
| あなたの組織 | `org/` — マネージャー、チーム、主要なコラボレーターを追加 |
| あなたのコンピテンシー | `perf/competencies/` — 組織のフレームワークに合わせる |
| あなたのツール | `.claude/commands/` — GitHub org、Slackワークスペースに合わせて編集 |
| あなたの規約 | `CLAUDE.md` — 運用マニュアル、使いながら進化させる |
| あなたのドメイン | フォルダの追加、`.claude/agents/`へのサブエージェント追加、`.claude/scripts/`への分類ルール追加 |

> [!IMPORTANT]
> `CLAUDE.md`は運用マニュアルです。規約を変更したら更新してください — Claudeは毎セッション読み込みます。

---

## 🔄 アップグレード

obsidian-mindの古いバージョン（または任意のObsidianボールト）をお使いですか？`/om-vault-upgrade`コマンドでコンテンツを最新テンプレートに移行できます：

```bash
# 1. 最新のobsidian-mindをクローン
git clone https://github.com/breferrari/obsidian-mind.git ~/new-vault

# 2. Claude Codeで開く
cd ~/new-vault && claude

# 3. 古いボールトを指定してアップグレードを実行
/om-vault-upgrade ~/my-old-vault
```

Claudeが以下を行います：
1. **検出** — ボールトのバージョンを特定（v1〜v3.2、またはobsidian-mind以外のボールトとして識別）
2. **棚卸し** — すべてのファイルを分類（ユーザーコンテンツ、スキャフォールド、インフラ、未分類）
3. **移行プランの提示** — コピー、変換、スキップされるものを正確に確認できます
4. **承認後に実行** — フロントマターの変換、ウィキリンクの修正、インデックスの再構築
5. **検証** — 孤立ノート、壊れたリンク、不足しているフロントマターをチェック

古いボールトは**一切変更されません**。`--dry-run`を使えば、実行せずにプランだけをプレビューできます。

> [!NOTE]
> obsidian-mindだけでなく、あらゆるObsidianボールトで動作します。obsidian-mind以外のボールトの場合、Claudeは各ノートを読んで意味的に分類し、作業ノート、人物、インシデント、1on1、意思決定を適切なフォルダに振り分けます。

---

## 🙏 設計上の影響を受けたもの

- [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) — 公式Obsidianエージェントスキル
- [James Bedford](https://x.com/jameesy) — ボールト構造の哲学、AI生成コンテンツの分離
- [arscontexta](https://github.com/agenticnotetaking/arscontexta) — descriptionフィールドによる段階的開示、セッションフック

---

## 👤 作者

**[Brenno Ferrari](https://brennoferrari.com)** が作成 — ベルリン在住のシニアiOSエンジニア、Claude Codeで開発者ツールを構築中。

---

## 📄 ライセンス

MIT
