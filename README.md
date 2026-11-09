# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## このフォークでの導入（Windows / Linux）

このチェックアウトには、upstream に対する次の変更が入っています。

- **Windows 対応パッチ**（`src/`）
  - `stateDir` と作業ディレクトリに `E:/…` 形式のパスを使える。
  - コマンドを PATHEXT で探す（`gh.exe` なども見つかる）。
  - `env` コマンドを使わず、環境変数を直接渡す。
  - `gh` などの差し替えファイル（シム）を `.cmd` で書き出す。
  - prepare コマンドを `pwsh` で実行する。
  - 主 Session で `pwsh` を使える。
- **`scripts/bootstrap.mjs`**：新しい PC で、ツールの確認からビルド、`gh-agent` の用意、プロファイルの起動、Superagent の設定までを 1 回で行う。
- **`scripts/setup-profile.mjs`**：superagent を入れた DSH プロファイルを作って起動する（`bootstrap.mjs` も中でこれを使う）。
- **`scripts/gh-agent.cs`**：Windows 用のエージェント `gh` ラッパーのソース。`bootstrap.mjs` が Windows 標準の `csc.exe` でコンパイルする。

どのスクリプトも Node だけで動くので、Windows と Linux の両方で使える。

### 別の PC に導入する（`bootstrap.mjs`）

```sh
git clone https://github.com/harayuu9/dsh-superagent-prototype.git
cd dsh-superagent-prototype
node scripts/bootstrap.mjs --repo polyscape-org/Kuebiko --allow harayuu9 --clone ~/src/Kuebiko
```

1. **ツール**：Node.js、git、gh のバージョンを確かめる。Windows では `pwsh` も確かめる。pnpm と dsh がなければ npm で入れる（dsh の版は `--dsh-version`、既定 0.2.1-rc.3）。
2. **コピー元のプロファイル**：`--from`（既定は `web`）がなければ作る。モデルのログインがなければ、ログインするよう案内して待つ。
3. **ビルド**：`pnpm install && pnpm build`。
4. **`gh-agent`**：Windows では `scripts/gh-agent.cs` から `.exe` を、それ以外ではシェルスクリプトを、`~/.local/bin` に作る。ログインしていなければ、ブラウザでエージェントのアカウントにログインさせる（`--insecure-storage` 付き）。`--repo` には push できるかも確かめる。
5. **clone**：`--clone` のパスに clone がなければ `--repo` から clone する。作業ディレクトリは既定で `<clone>/../work`。
6. **プロファイル**：`setup-profile.mjs` で作って起動する。すでに動いていれば、再起動せずに更新だけする。
7. **Superagent の設定**：管理 API で保存する。保存するのは GitHub Source（リポジトリと、この PC の `gh-agent` のパス）、Policy（`--allow`）、Execution（作業ディレクトリと、この PC の clone を使う prepare コマンド）、プロンプト（コミットの作者。既定はエージェントのアカウント。auto-merge なし）。

| オプション | 内容 |
|---|---|
| `--profile <名前>` / `--port <n>` / `--from <名前>` | 作るプロファイル（既定 `superagent`）、ポート（既定 3082）、コピー元（既定 `web`） |
| `--repo <owner/name>` | 対象のリポジトリ |
| `--allow <login,...>` | 依頼できる GitHub アカウント |
| `--clone <dir>` / `--work <dir>` | ワークツリーの元になる clone と、作業ディレクトリ |
| `--author <login>` | コミットの作者（既定はエージェントのアカウント） |
| `--export <file>` | 動いているプロファイルの設定を JSON に書き出して終わる |
| `--settings <file>` | `--export` の JSON を読み込んで反映する。PC ごとに違うパス（CLI、clone）はこの PC の値に置き換わる |
| `--skip-login` / `--yes` | ログインしない、質問しない。人の手が要るところでは止まる |

- **自動化できない手順**：ツール本体（Node.js、git、gh、pwsh）のインストール、モデルのログイン、エージェントの GitHub ログインは人がやる。足りないものがあると、スクリプトはやり方を表示して止まるか、待つ。
- **何度実行してもよい**：済んでいる手順は飛ばす。
- **設定を持ち運ぶ**：今の PC で `node scripts/bootstrap.mjs --export superagent.json` を実行し、新しい PC で `--settings superagent.json --clone <パス>` を付けて実行する。JSON に秘密の情報は入らない（認証は各 PC の `gh-agent` が持つ）。

同じエージェントのアカウントと同じリポジトリで、2 台の PC から同時に Superagent を動かさないこと。どちらも同じ通知を読み、同じ依頼に二重に反応する。移すときは、先に元の PC の Superagent を止める。

以下は、スクリプトがやっていることを一つずつ手でやる場合の説明。

### 1. ビルド

```sh
pnpm install && pnpm build
```

ビルド済みの `lib/` を、プロファイルから `link:` で読みます。`src/` を変えたら、ビルドしてからプロファイルを再起動してください。

### 2. プロファイルを作って起動する

```sh
node scripts/setup-profile.mjs <プロファイル名> --port <ポート> [オプション]

# 例
node scripts/setup-profile.mjs superagent --port 3082
```

1. 既存のプロファイル（既定は `web`）から、プラグイン一覧、設定（`cordis.patch.yml`）、ロックファイルをコピーする。モデルのログイン（`<DSH_HOME>/.credentials.yaml`）は同じ DSH ホームのプロファイルで共有されるので、ログインし直す必要はない。
2. このチェックアウトを `link:` で追加し、ポートと `stateDir` をプロファイルの `cordis.patch.yml` に書く。目印で囲んだ範囲に書くので、再実行するとその範囲だけが置き換わる。
3. 組み立てた設定を検証してから切り離して起動する。API が応答するまで待ち、まだ済んでいない設定があれば表示する。ログは `<プロファイル>/.artifacts/` に残る。

| オプション | 内容 |
|---|---|
| `--port <n>` | Web サーバーのポート。新しく作るときは必須で、以降は前回の値を引き継ぐ |
| `--from <名前>` | コピー元のプロファイル（既定は `web`） |
| `--state-dir <パス>` | 状態ディレクトリ（既定は `<DSH_HOME>/state/<プロファイル名>`） |
| `--host <ホスト>` | 待ち受けるホスト（既定は `127.0.0.1`） |
| `--reset` | 既存のプロファイルを消し、コピー元から作り直す（そのプロファイル独自の設定は失われる） |
| `--no-start` | インストールだけして起動しない |
| `--foreground` | 切り離さず、このターミナルで起動する |

- **再実行しても安全:** 既存のプロファイルはそのまま残り、Superagent の画面や API で保存した設定（Source、Policy、Execution、プロンプト）も消えない。
- **プロファイルをコピーした時点の設定になる:** あとでコピー元の設定を変えても反映されない。`link:` で入れたプラグインはコピー元と同じフォルダを指すので、コードの変更は反映される。
- **空のロックファイルを片付ける:** 起動の前に、異常終了で残った空の `<DSH_HOME>/.credentials.yaml.lock` を消す。これが残っているとどのプロファイルも起動できない。
- **停止の機能はない:** 止めるときは dsh のプロセスを終了する。

### 3. 複数のリポジトリ

GitHub Source は 1 つのリポジトリしか扱えないので、リポジトリごとにプロファイルを分けます。

```sh
node scripts/setup-profile.mjs superagent-foo --port 3083
```

- エージェントのアカウントは共用してよい。通知はそれぞれのプロファイルが自分のリポジトリだけに絞って読む。
- プロセスが分かれるので、片方が重くなったり落ちたり再起動したりしても、もう片方に影響しない。プロセス全体の `PATH` と git 設定を書き換える影響も混ざらない。

### 4. エージェントの GitHub CLI

エージェント専用の設定ディレクトリを使う `gh` のラッパーを用意し、GitHub Source の「CLI」に絶対パスで指定します。

- **Linux / macOS:** [006 Deployment](docs/006-deployment.md) にある `gh-agent` のシェルスクリプト。
- **Windows:** 実行ファイル（`.exe`）にする。バッチファイル（`.cmd`）は、Node の `execFile` が `EINVAL` で起動を拒否する（Node のセキュリティ修正による）。設定の保存時のチェックは通ってしまうが、ポーリングで失敗する。`bootstrap.mjs` は [scripts/gh-agent.cs](scripts/gh-agent.cs) を Windows 標準の C# コンパイラでビルドする。手でビルドするなら次のとおり。

  ```powershell
  & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize "/out:$env:USERPROFILE\.local\bin\gh-agent.exe" scripts\gh-agent.cs
  ```

  ログインはエージェントのアカウントで行う。

  ```powershell
  & "$env:USERPROFILE\.local\bin\gh-agent.exe" auth login --hostname github.com --git-protocol https --web --insecure-storage
  ```

- **`--insecure-storage` を必ず付ける（Windows / Linux 共通）:** 付けないと、トークンが OS のキーリング（Windows では資格情報マネージャー）に保存される。そこでは `GH_CONFIG_DIR` が違っても同じ項目を使うので、普段の `gh` までエージェントのアカウントで動くようになる。付けると、トークンは `gh-agent` の設定フォルダの `hosts.yml` にだけ保存される。
- **混ざってしまったら:** 普段の `gh` は `gh auth switch --user <自分のアカウント>` で戻す。git の資格情報（Windows では `cmdkey /list` の `git:https://github.com`）がエージェントになっていたら、その項目を削除する。

### 5. Windows での prepare コマンド

Windows では、prepare コマンドを `pwsh -NoProfile -NonInteractive -Command` で実行します。チケットの変数は `$env:DSH_SUPERAGENT_…` で読みます。各チケットに専用クローンの worktree を作る例です。

```powershell
$ErrorActionPreference = 'Stop'
$repo = 'E:\Program\DSHSuperAgent\Kuebiko'
$src = if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) { $env:DSH_SUPERAGENT_GITHUB_PR_HEAD } else { 'HEAD' }
$ref = "refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"
git -C $repo fetch --no-tags "https://github.com/$env:DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${src}:$ref"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
git -C $repo worktree add -b "agent/$env:DSH_SUPERAGENT_NAME" "$env:DSH_SUPERAGENT_DIR" $ref
exit $LASTEXITCODE
```

### 6. 状態の確認と死活チェック

付属の `scripts/dsh-superagent`（tmux と fcntl を使う）は Windows では動きません。代わりに管理 API で状態を見ます。

```sh
curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:<ポート>/orchestrator/api/state
```

| 状態 | 対処 |
|---|---|
| `setup.problem` が `null` で、`health` に `error` がない | 正常（`starting` と `paused` も正常） |
| 応答がない | `node scripts/setup-profile.mjs <プロファイル名>` を再実行すれば起動し直す |

毎時の死活チェックは、普段使いのプロファイルのスケジュールに、この確認と再起動を頼むプロンプトを登録します。

### 7. Windows で残っていること

- 付属のテストのうち、POSIX を前提にしたもの（`sleep`、`sh`、シムのファイル名など）は Windows では失敗します。テストは Windows 向けに直していません。
- 作業セッションが使う `gh` のシム（`<stateDir>/worker-bin/gh.cmd`）は、エージェントの PowerShell から呼ばれる前提です。Node から直接起動すると、上と同じ `EINVAL` の制約にかかります。

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
