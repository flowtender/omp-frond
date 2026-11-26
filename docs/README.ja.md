# omp-frond

[English](../README.md) | [简体中文](./README.zh-CN.md) | [Русский](./README.ru.md)

[oh-my-pi（omp）](https://github.com/can1357/oh-my-pi) コーディングエージェントのブラウザー UI です。omp-frond は `omp` CLI がすでに書き込んでいるセッションを読み込み、会話の閲覧、リアルタイムのチャット、モデルロール、Provider 設定、スキル管理、プロジェクトファイルのプレビューをブラウザーで提供します。

このリポジトリ `flowtender/omp-frond` は omp-web のフォークです。UI は [pi-web](https://github.com/agegr/pi-web)（作者 [@agegr](https://github.com/agegr)）に由来し、[ddallabenetta/omp-web](https://github.com/ddallabenetta/omp-web) と [KD-MM2/omp-web](https://github.com/KD-MM2/omp-web) の OMP 適応を取り込んでいます。OMP SDK（[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)）は正確なバージョンに固定された依存関係です。ブランチ構成と更新手順は英語のガイド [docs/upstream-maintenance.md](./upstream-maintenance.md) を参照してください。

## クイックスタート

omp SDK は TypeScript のソースとして配布され、`bun:` の組み込みモジュールを import するため、omp-frond の API は **Bun** で動作します。必要な環境は **Bun 1.4.4 以降**と **Node.js 22.19.0 以降**です（`package.json` の `engines` を参照。インストール時の `postinstall` は Node で実行されます）。

### ソースから実行（このフォーク）

このリポジトリのソースチェックアウトが、このフォークのビルドです：

```bash
git clone https://github.com/flowtender/omp-frond.git
cd omp-frond
bun install
bun run dev                      # 開発サーバー：http://127.0.0.1:30141
```

同じチェックアウトで本番版を実行する場合は、先にビルドしてから起動します：`bun run build` の後に `bun run start`（`127.0.0.1:30141` で待ち受け。`bun run start:lan` は `0.0.0.0` にバインドします）。同じチェックアウトで `bun run dev` を実行中にビルドしないでください。どちらも `.next/` を使用します。

### 上流の npm パッケージ

npm の `omp-web` パッケージは上流の [ddallabenetta/omp-web](https://github.com/ddallabenetta/omp-web) から公開されており、その `package.json` もそのリポジトリを指しています。このフォークが npm に公開されていることを示すものではなく、このフォークの変更も含みません。上流のディストリビューションを使いたい場合にのみ利用してください：

```bash
bunx omp-web@latest
```

グローバルにインストールする場合：

```bash
bun add -g omp-web    # または：npm install -g omp-web
omp-web
```

サーバーの準備が整うと、CLI は自動的にブラウザーを開こうとします。開かない場合は [http://127.0.0.1:30141](http://127.0.0.1:30141) にアクセスしてください。CLI はデフォルトで `127.0.0.1` のみをリッスンします。モデル Provider が未設定の場合は、**Models** パネルを開いてログインするか API Key を追加してください。`omp-frond` のエントリポイントは Node または Bun で動作し、Bun を見つけてその中でサーバーを再実行します。特定の Bun を使う場合は `OMP_FROND_BUN=/path/to/bun` を設定します。

Windows で `bunx` が起動前に `EPERM: Operation not permitted (NtSetInformationFile())` で失敗する場合、原因は omp-frond ではなく Bun の Windows キャッシュの名前変更です。Bun を更新し、キャッシュを消去してから再試行してください。

## 主なオプション

コマンドラインオプションは、対応する環境変数より優先されます。

```bash
omp-frond --port 8080              # ポートを変更
omp-frond --hostname 0.0.0.0       # 信頼できるネットワークに公開
omp-frond --no-open                # ブラウザーを自動的に開かない
omp-frond --authenticated          # パスワードを有効化（未設定なら端末で入力を求める）
omp-frond --reset-password         # パスワードを忘れた場合に新しく設定
```

| オプションまたは環境変数 | 用途 | デフォルト |
| --- | --- | --- |
| `--port <port>`、`-p`、または `PORT` | サーバーポート | `30141` |
| `--hostname <host>`、`-H`、または `OMP_FROND_HOSTNAME` | バインドするホスト名 | `127.0.0.1` |
| `--no-open`、または `OMP_FROND_NO_OPEN=1` | ブラウザーを自動的に開かない | 自動的に開く |
| `--authenticated`、または `OMP_FROND_AUTHENTICATED=1` | パスワードロックを有効化 | 無効 |
| `OMP_FROND_PASSWORD` | 保存されたパスワードを上書き | 未設定 |
| `OMP_FROND_ALLOWED_HOSTS` | リバースプロキシ用の追加の完全一致ホスト名（カンマ区切り） | 未設定 |

ネイティブ HTTPS は `--tls-cert cert.pem --tls-key key.pem` で有効になります。詳細は [HTTPS](./https.md) を参照してください。

## パスワードとアクセス

**Settings → Access** でパスワードを設定し、ロックのオン／オフを切り替えられます。`--authenticated` または `OMP_FROND_PASSWORD` を使うこともできます。パスワードは `scrypt` ハッシュとして `~/.omp/agent/omp-frond-auth.json`（モード `0600`）に保存されます。パスワードを忘れた場合は、サーバーで `omp-frond --reset-password` を実行するか、`/recover` を開いてサーバーのコンソールに表示された一度限りのコードを入力してください。

omp-frond は高い権限を持つエージェントを呼び出せるため、ログインパスワードとセッション Cookie は[ネイティブ HTTPS](./https.md)、信頼できる HTTPS リバースプロキシ、または信頼できる VPN で保護してください。脅威モデルの詳細は [authentication.md](./authentication.md) にあります。

## モデルロール

omp は作業範囲ごとにモデルを割り当てます。omp-frond は TUI の `/model` セレクターと `Ctrl+P` のサイクルで使われるロールと同じものを表示します：`default`、`smol`、`slow`、`plan`、`commit`、`task`、`advisor`、`vision`、`designer`、`tiny`。

ロールの割り当ては `~/.omp/agent/config.yml` の `modelRoles` に保存されます（**This project** を選ぶと `.omp/config.yml`）。ブラウザーで行った割り当ては、次にターミナルのセッションを起動したときにも使われます。

## HTTP プロキシ

サーバー側のモデルと API のリクエストは、標準の `HTTP_PROXY` と `HTTPS_PROXY` 環境変数を使用します。Bun はプロセス起動時に一度だけこれらを読むため、起動前に設定してください：

```bash
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 bunx omp-web@latest
```

ループバックアドレスへのリクエストはプロキシされないため、プロキシを設定してもローカルの Provider（Ollama、LM Studio、llama.cpp）は動作します。Bun は現時点では他のホストに対する `NO_PROXY` を尊重しない点に注意してください。

## 注意事項

- **データディレクトリ**：デフォルトでは `~/.omp/agent/sessions` を読み込みます。別の omp エージェントディレクトリを使う場合は `PI_CODING_AGENT_DIR` を設定してください（変数名は omp のものを踏襲しています）。
- **セッションファイル**：`~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`。
- **Provider 設定**：Models パネルはエージェントディレクトリの `models.yml` を読み書きします。認証情報は omp の `agent.db` にあり、CLI と共有されます。
- **プロジェクトの信頼**：`.omp/extensions`、`.omp/hooks`、`.omp/tools`、`.mcp.json` は明示的に信頼されるまで実行されません。詳細は [Project trust](./project-trust.md) を参照してください。
- **ファイルアクセスの範囲**：ファイルの閲覧とプレビューは、選択したプロジェクトディレクトリとセッションに現れる作業ディレクトリに限定されます。
- **Git worktree**：スイッチャーの表示条件、作成、削除については [worktree の説明](./worktrees.zh-CN.md) を参照してください。
- **国際化**：翻訳の利用と追加については [Internationalization](./i18n.md) を参照してください。

## 機能

- **会話の再開**：プロジェクトごとに以前の omp の会話を閲覧できます。
- **ロールごとのモデル選択**：作業範囲ごとにモデルを割り当てて切り替えられます。
- **安全な分岐**：以前のメッセージから続けたり、セッションを別のルートに分岐したりできます。
- **ブランチをまたいだ作業**：サイドバーから Git worktree を切り替えられます。
- **プロジェクトと並べてチャット**：ファイルを閲覧・アップロードし、ソース、Markdown、画像、音声、PDF をプレビューできます。
- **チャットの横にターミナル**：Explorer から選択したディレクトリでシェルを開けます。

## 開発

このリポジトリのソースチェックアウトで開発してください。Bun 1.4.4 以降と Node.js 22.19.0 以降が必要です。

```bash
git clone https://github.com/flowtender/omp-frond.git
cd omp-frond
bun install
bun run dev
```

開発サーバーは [http://127.0.0.1:30141](http://127.0.0.1:30141) で動作します。一般的なチェックは次のコマンドで実行します：

```bash
bun run typecheck
bun run lint
bun run test
```

通常の開発中は `bun run build` や `next build` を実行しないでください。`.next/` に書き込まれ、開発サーバーに影響するおそれがあります。ビルドはリリース作業の際にのみ行ってください。

新機能に取りかかる前に、[Contributing](../CONTRIBUTING.md) で変更の提出先と PR 前のチェック項目を確認してください。リモート、上流の同期、提出の流れ、SDK のアップグレードについては、英語の正式ガイド [docs/upstream-maintenance.md](./upstream-maintenance.md) を参照してください。

## ライセンス

[MIT](../LICENSE)
