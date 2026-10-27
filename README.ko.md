# cloudroom-mcp

[English](README.md) | [한국어](README.ko.md)

**버전 0.1.0 — 첫 릴리즈.** GitHub으로 배포하며 npm에는 게시하지 않습니다.

[MIT 라이선스](LICENSE)로 배포합니다.

`room-cli`를 감싸는 **Cloud 전용 stdio MCP 서버**. 로컬 Pi/Devin은 지시·조회만 하고,
실제 에이전트와 작업 공간은 Cloudroom Cloud VM에서 실행됩니다.

- 도구는 `thread_spawn`, `thread_tell`, `thread_get`, `thread_stop` 네 개.
- Node.js 22+, 빌드 불필요. MCP SDK v2 사용, 2025-11-25 legacy stdio 연결도 테스트.
- Cloudroom 제어 서버가 로컬에서 실행되어 있어야 합니다. **로컬 제어 서버 ≠ 로컬 에이전트 실행.**
- Cloud 인증과 provider의 인증/실행 준비는 Cloudroom에서 미리 완료해야 합니다. GitHub 접근은 저장소 프로젝트에 필요하며, Personal에는 필요하지 않습니다.
- 이 저장소는 MCP 서버만 제공합니다. SKILL 작성·전역 MCP 설정 변경은 하지 않습니다.

## 원본 프로젝트

Cloudroom과 `room-cli` 저장소: [davidondrej/cloudroom-core](https://github.com/davidondrej/cloudroom-core).
이 저장소는 `room-cli`를 호출하는 별도의 MCP 어댑터입니다. CLI에 없는 GitHub 전용 프로젝트 등록만 Cloudroom 내부 HTTP API로 처리합니다.

## 설치 및 실행

```bash
cd ~/orca/projects/cloudroom-mcp
npm ci
node server.mjs
```

프로젝트 설정 없이 시작할 수 있습니다. 기본값은 저장소와 base branch가 없는 Personal(`proj_personal`)입니다.
기본값을 바꾸려면 선택적으로 `.env.example`을 `.env`로 복사하고 `node --env-file=.env server.mjs`로 실행하세요.

stdio 서버이므로 직접 실행하면 입력을 기다리는 것이 정상입니다.
stdout에는 MCP JSON-RPC만 나갑니다. 일반 로그·시작 오류는 stderr로 나갑니다.
`npm start`는 환경 변수를 자동으로 읽지 않습니다. 이미 설정된 환경에서 사용하세요.

Personal을 기본값으로 유지하면서 GitHub 저장소를 허용하려면 `.env`에 다음을 설정하세요:

```dotenv
CLOUDROOM_ALLOWED_GITHUB_REPOS=owner/repository
```

또는 `CLOUDROOM_GITHUB_REPO=owner/repository`으로 기본 저장소를 지정하면 해당 저장소도 자동으로 허용됩니다.
로컬 clone·머신 source 연결·프로젝트 ID 조회·수동 프로젝트 생성은 필요 없습니다.

## 기본값과 옵션

| 항목 | 기본값 | 변경 방법 |
|---|---|---|
| machine | `cloud` | 현재 Cloud만 허용. Local/native 실행은 의도적으로 제외 |
| base_branch | 생략 | 저장소 프로젝트에서만 spawn 입력 또는 `CLOUDROOM_DEFAULT_BASE_BRANCH`; Personal에는 전달하지 않음 |
| provider | `acp-devin` | spawn/tell 입력 또는 `CLOUDROOM_DEFAULT_PROVIDER` |
| model | `gpt-6-1-sol-high` | spawn/tell 입력 또는 `CLOUDROOM_DEFAULT_MODEL` |
| reasoning_level | `high` | spawn/tell 입력 또는 `CLOUDROOM_DEFAULT_REASONING_LEVEL` |
| github_repo | 생략 → Personal(내부 ID는 `proj_personal`) | 선택적 `CLOUDROOM_GITHUB_REPO`; 도구에는 허용된 GitHub `owner/repository`만 지정 가능 |

`CLOUDROOM_GITHUB_REPO`가 없거나 공백이면 Personal을 선택합니다. 기본 저장소는 자동으로 허용되며,
추가 저장소는 `CLOUDROOM_ALLOWED_GITHUB_REPOS`에 쉼표로 구분해 지정합니다. 둘 다 없으면 Personal만 허용됩니다.
`get/tell/stop`은 Cloud 여부와 프로젝트의 현재 GitHub remote를 확인하며, 이름이나 기억해 둔 프로젝트 ID만으로 허용하지 않습니다.

저장소 입력은 `owner/repository` 형식만 받습니다. URL·SSH clone 문자열·`.git` 접미사·프로젝트 ID·이름·로컬 경로는 거부합니다.
대소문자는 구분하지 않습니다. 잘못되었거나 접근할 수 없는 저장소를 Personal이나 로컬 실행으로 대체하지 않습니다.
이전 `project` 도구 인자와 비어 있지 않은 `CLOUDROOM_PROJECT_ID` / `CLOUDROOM_ALLOWED_PROJECT_IDS` 설정도 거부하므로 GitHub 식별자로 바꿔야 합니다.

Personal에는 저장소가 없으므로 서버의 branch 기본값도 적용하지 않습니다. Personal에 `base_branch`를 명시하면 CLI 호출 전에 오류를 반환합니다.
저장소 프로젝트에서는 branch를 생략하면 Cloudroom 자체 기본값을 사용하며, `CLOUDROOM_DEFAULT_BASE_BRANCH`로 덮어쓸 수 있습니다.

**LLM은 사용자의 지시에 따라 옵션을 지정할 수 있습니다.** 도구 설명과 서버 instructions에 기본값도 제공됩니다.
생략한 실행 옵션은 기존 스레드 설정이 아니라 **서버 기본값**으로 해석합니다.
다른 provider를 선택할 때는 호환되는 `model`·`reasoning_level`도 함께 지정하세요.
provider별 유효 모델은 Cloudroom/해당 provider가 최종 검증합니다. 모델 이름을 추측해 변환하지 않습니다.

Devin의 CLI provider ID는 Cloud에서도 `acp-devin`입니다. 내부 harness 이름 `devin`과 다릅니다.
`gpt-6.1-sol`은 테스트에서 거부됐고, `gpt-6-1-sol-high`는 응답까지 확인했습니다.
모델 이름의 `high` 접미사와 별개로 `--reasoning-level high`를 항상 명시합니다.

Cloud는 full permissions로 실행합니다. 이 서버의 입력 검증은 원격 에이전트를 제한된 sandbox 권한으로 바꾸지 않습니다.
요청 실행은 계정의 모델/Cloud 사용량을 소비할 수 있습니다.

## 도구

### thread_spawn

```json
{
  "request_id": "b8f7774e-6e7c-42d8-bd16-35b2a3adc22e",
  "prompt": "저장소를 살펴보고 테스트 구성을 요약하세요.",
  "title": "GitHub 저장소 확인",
  "github_repo": "owner/repository",
  "machine": "cloud",
  "provider": "acp-devin",
  "model": "gpt-6-1-sol-high",
  "reasoning_level": "high"
}
```

필수: `request_id`(UUID), `prompt`. 선택: `title`, `github_repo`, 위 실행 옵션.
서버 기본 저장소를 설정하지 않고 `github_repo`를 생략하면 Personal에서 작업합니다.

GitHub 저장소를 지정하면 서버가 다음 순서로 처리합니다:
1. 저장소 허용 목록을 확인하고 Cloudroom 프로젝트의 GitHub remote 메타데이터로 검색합니다.
2. 일치하는 프로젝트가 있으면 재사용합니다. 여러 개면 임의로 고르지 않고 오류를 반환합니다.
3. 없으면 `POST /api/v1/cloudroom/account/repo-suggestions/github`에 `{"repo":"owner/repository"}`를 보내 등록합니다.
4. 반환된 프로젝트의 GitHub remote를 재확인한 뒤 내부 ID를 Cloud `thread spawn`에 전달합니다.

등록 endpoint는 내부 API이므로 Cloudroom 버전에 따라 바뀔 수 있습니다. 로컬 source 없는 프로젝트를 생성하거나 기존 프로젝트를 재사용·숨김 해제할 수 있습니다.
`project create --root`, `project source add`, 로컬 clone·연결 명령은 호출하지 않습니다.
`repository_registration_used`는 HTTP 등록 경로를 사용했는지를 뜻하며, 반드시 새 프로젝트가 생성되었다는 뜻은 아닙니다.
등록 성공이 Cloud의 저장소 접근·clone 성공까지 보장하지는 않으므로 이후 스레드 오류도 확인해야 합니다.
후속 단계가 실패해도 등록을 자동으로 되돌리지 않으며, 오류에 실패 단계와 확인된 부분 변경을 포함합니다.

하나의 논리적 생성마다 UUID를 한 번 생성합니다. 응답 유실·타임아웃으로 결과가 불명확하면
**같은 UUID와 같은 옵션·프롬프트**를 사용하세요. 새 UUID로 무작정 재생성하지 마세요.
Cloudroom의 request ID 처리를 사용하며, 서버는 자동 재시도하지 않습니다.
동일 ID의 충돌 처리와 이미 생성된 스레드 복구는 Cloudroom의 동작에 따릅니다.

스레드 ID와 접수 상태를 즉시 반환합니다. 생성 성공은 초기화나 작업 완료를 의미하지 않습니다.

### thread_tell

```json
{
  "thread_id": "thr_example",
  "prompt": "pwd && ls -la 의 결과를 출력하세요.",
  "model": "gpt-6-1-sol-high",
  "reasoning_level": "high",
  "mode": "queue"
}
```

필수: `thread_id`, `prompt`. 선택: `provider`, `model`, `reasoning_level`, `mode`(`queue` 기본, `steer`, `auto`).

순서:
1. Cloud 여부·허용된 GitHub remote 또는 Personal·현재 실행 설정 확인. 변경이 필요하면 interaction 목록도 직접 조회해 pending/resolving 상태를 차단.
2. 요청 설정이 다르면, idle/error이며 큐·pending interaction이 없는 경우에만 `thread update`.
3. 변경된 설정을 `thread show`로 재확인.
4. `thread tell`에 모델·reasoning을 명시해 전송.

모델/provider 변경은 **Cloudroom 스레드와 이력을 유지해도 내부 에이전트 세션을 교체할 수 있습니다.**
반환값 `settings_updated`, `native_session_may_have_changed`를 확인하세요.
다른 제어기나 GUI가 설정을 바꾸면 HTTP 409 등이 날 수 있습니다. 숨겨서 재전송하지 않습니다.

tell에는 CLI에서 제공하는 idempotency key가 없습니다. 타임아웃 뒤 무작정 재전송하면 중복 지시가 될 수 있습니다.
결과가 `sent` 또는 `queued`여도 작업이 끝난 것은 아닙니다.
설정 변경 후 전송이 실패하면 오류에 `phase`·`settings_updated`를 포함합니다. 자동 rollback도 하지 않습니다.

### thread_get

```json
{ "thread_id": "thr_example", "after_seq": 0, "event_limit": 20 }
```

상태·확인된 `github_repo`(Personal은 null)·CLI 실행 설정·최신 출력·오류·이벤트 페이지를 반환합니다.
`event_limit`은 1–100, 기본 20. `next_after_seq`를 다음 조회의 `after_seq`로 넘깁니다.
`possibly_more_events=true`이면 계속 페이지를 읽으세요. 페이지가 꽉 찼다는 보수적인 표시이므로 빈 페이지가 한 번 더 나올 수 있습니다.

**`latest_available_output`은 이전 턴 결과일 수 있습니다.**
새 프롬프트 뒤에는 이벤트의 `request_id`와 실제 종료/오류 이벤트를 연결해 판정하세요.
이벤트의 종류와 data는 CLI가 반환한 것을 사용합니다. `completion_verified`는 항상 false이며,
이 어댑터가 `idle`이나 출력 존재만으로 특정 요청의 성공을 보증하지 않는다는 뜻입니다.

관측은 원자적 snapshot이 아닙니다. 전후 상태가 바뀌면 `snapshot_changed=true`로 표시합니다.
CLI 실행 설정과 실제 응답/오류를 같이 보고 GUI label만 신뢰하지 마세요.
에이전트의 모델 자기보고 역시 독립적인 모델 실행 증명은 아닙니다.

출력은 16,000자, 출력/마지막 오류는 각각 8,000자로 제한하고 절단 여부를 표시합니다.
큰 이벤트 data는 제한된 JSON 문자열 preview와 `data_truncated=true`로 반환합니다.
개별 이벤트 data가 절단되어도 이벤트 seq와 request ID는 유지합니다.

### thread_stop

```json
{ "thread_id": "thr_example" }
```

작업 중지 요청만 합니다. archive/delete/VM 삭제를 하지 않습니다.
`process unavailable` 같은 오류도 성공으로 바꾸지 않습니다.
MCP 연결 종료나 MCP 호출 취소도 원격 작업을 자동 중지하지 않습니다.

## 안전장치

- shell 없이 절대 경로 executable + argv 배열로 호출. prompt는 옵션으로 해석되지 않게 전달.
- CLI 경로 기본 `~/.local/bin/room-cli`. `CLOUDROOM_CLI_PATH`로 절대 경로만 설정 가능.
- `CLOUDROOM_SERVER_URL`은 loopback HTTP origin만 허용. 기본 `http://127.0.0.1:39886`.
- 호출한 Pi/Devin의 `ROOM_*`·automation 문맥을 제거하고 지정된 제어 서버만 사용.
- Local fallback, 파일 업로드, 로컬 checkout 전송, 임의 CLI 플래그, 자동 승인, archive/delete 도구 없음.
- GitHub 등록은 지정한 loopback 제어 서버에 JSON으로만 요청하며 쿠키·redirect 추적·자동 재시도를 사용하지 않습니다. 응답은 64 KiB로 제한합니다.
- 저장소 조회·등록과 CLI 호출을 합친 요청별 전체 deadline은 기본 45초입니다. `CLOUDROOM_TIMEOUT_MS`로 100–120000ms 설정 가능.
  클라이언트의 MCP timeout은 이 값보다 길게 설정하세요(예: 60초).
- CLI stdout/stderr는 stream별 1 MiB 제한. 오류를 structured MCP error로 반환.
  `outcome_unknown=true`는 원격 부작용이 없었다고 단정할 수 없다는 뜻.
- 자동 write 재시도 없음. stderr/에이전트 응답은 신뢰할 수 없는 데이터로 취급.
- thread/request 및 GitHub 저장소별 OS exclusive 파일 잠금으로 별도 MCP 프로세스 간 동시 변경과 중복 등록 경쟁도 차단합니다.
  잠금 중 두 번째 요청은 대기/재시도하지 않고 `operation_locked` 오류를 반환.
  별도의 GUI/CLI 조작은 이 잠금에 참여하지 않으므로 최종 Cloudroom 오류도 그대로 보고.
- 프롬프트와 원격 출력은 Cloudroom에 저장될 수 있으며 process argv에서도 보일 수 있습니다.
  자격 증명은 프롬프트/옵션에 넣지 말고 Cloudroom의 인증/secret 경로를 사용하세요.

### 잠금 복구

기본 잠금 경로는 `~/.local/state/cloudroom-mcp/locks`.
Pi/Devin 양쪽에서 같은 경로를 사용하세요. 필요하면 절대 경로 `CLOUDROOM_LOCK_DIR`로 변경합니다.

프로세스가 강제 종료되면 잠금이 남을 수 있습니다. 안전을 위해 자동으로 빼앗지 않습니다.
`operation_locked` 오류의 `lock_path` 파일에서 pid·key·생성 시각을 확인하고,
**해당 프로세스가 종료됐으며 원격 지시가 접수됐는지도 확인한 뒤에만** 그 잠금 파일을 직접 제거하세요.
잠금 디렉터리를 무작정 비우거나 살아 있는 프로세스의 잠금을 삭제하지 마세요.

## 일반 코딩 에이전트의 MCP 설정에 추가

### 1. 서버 의존성 설치

이 저장소를 로컬에 clone한 디렉터리에서 실행합니다:

```bash
cd /absolute/path/to/cloudroom-mcp
npm ci
node --version
room-cli --version
```

Node.js 22 이상을 사용하고 저장소 경로를 유지하세요.
빌드·npm 전역 설치·별도 백그라운드 서비스·Pi 확장 패키지는 필요 없습니다.
코딩 에이전트가 이 stdio 서버를 자식 프로세스로 실행합니다.
로컬 Cloudroom 제어 서버는 계속 실행 중이어야 하며 Cloud/provider 인증도 준비되어 있어야 합니다.

### 2. 로컬 stdio MCP 서버 등록

`mcpServers` JSON 형식의 클라이언트에서는 다음 entry를 기존 MCP 설정에 병합합니다:

```json
{
  "mcpServers": {
    "room": {
      "command": "node",
      "args": [
        "/absolute/path/to/cloudroom-mcp/server.mjs"
      ]
    }
  }
}
```

placeholder를 실제 `server.mjs` 위치로 바꾸고, 다른 서버 설정을 덮어쓰지 마세요.
`command`는 실행 파일 하나이며 `args`는 shell 명령 문자열이 아닌 인자 배열입니다.
GUI 클라이언트의 PATH에서 `node`를 찾지 못하면 `command`를 Node 실행 파일의 절대 경로로 지정하세요.
**`room-cli`를 직접 등록하지 말고 `server.mjs`를 등록**해야 합니다. CLI 자체는 MCP 프로토콜을 처리하지 않습니다.
이 서버는 **stdio 방식**이므로 HTTP MCP 서버로 설정하거나 Cloudroom 제어 URL을 MCP URL로 넣으면 안 됩니다.

설정 위치와 형식은 에이전트마다 다릅니다. `mcpServers` 대신 `servers`나 TOML을 쓰는 경우에는
같은 실행 파일·인자·환경 변수를 해당 클라이언트 문서의 형식에 맞춰 등록하세요.
공통 예제에서는 Pi 전용 `exposure`와 클라이언트별 timeout 항목을 제외했습니다.

### 3. GitHub 저장소 허용 설정(선택)

위 최소 설정은 환경 변수 없이 Personal을 사용합니다.
Personal을 기본값으로 유지하면서 저장소를 허용하려면 `room` entry의 `env`에 다음 값을 넣으세요:

```json
{
  "CLOUDROOM_ALLOWED_GITHUB_REPOS": "owner/repository"
}
```

여러 저장소는 `owner/repository`를 쉼표로 구분합니다.
기본 저장소도 지정하려면 대신 `CLOUDROOM_GITHUB_REPO=owner/repository`를 설정하면 해당 저장소가 자동으로 허용됩니다.

.env 파일을 쓰려면 `.env.example`을 `.env`로 복사해 수정한 뒤 다음 서버 entry를 사용합니다:

```json
{
  "command": "node",
  "args": [
    "--env-file=/absolute/path/to/cloudroom-mcp/.env",
    "/absolute/path/to/cloudroom-mcp/server.mjs"
  ]
}
```

`--env-file`을 넘기거나 값을 프로세스 환경으로 전달하지 않으면 .env 파일은 자동으로 로드되지 않습니다.
설정을 바꾼 뒤에는 코딩 에이전트의 MCP 연결을 재시작하거나 새로고침하세요.
클라이언트가 요청 timeout을 지원하면 서버 기본 deadline인 45초보다 길게(예: 60초) 설정하되, 단위는 해당 클라이언트 문서를 따릅니다.
`thread_spawn`, `thread_tell`, `thread_get`, `thread_stop` 네 도구가 나타나는지 확인하세요.
도구 목록 확인만으로 Cloud 작업이 생성되지는 않습니다.

## Pi에 설치·연결

이 저장소는 Pi 확장/패키지가 아니라 외부 MCP 서버입니다. Pi 내장 MCP 기능으로 등록하며,
이 저장소에 대해 `pi install`을 실행할 필요는 없습니다.

### 1. 의존성 설치 및 등록

위 안내대로 서버 저장소에서 `npm ci`를 한 번 실행합니다. Personal만 사용하려면:

```bash
pi mcp add room --exposure direct -- node /absolute/path/to/cloudroom-mcp/server.mjs
pi mcp list
pi
```

`--exposure direct`는 네 도구를 모델에 직접 노출합니다.
설정은 `~/.pi/agent/mcp.json`에 저장되며 Pi가 서버를 실행하므로 별도로 켜둘 필요는 없습니다.
같은 이름의 `room`이 이미 있으면 `pi mcp add room`이 그 entry를 교체하므로 기존 설정부터 확인하세요.
다른 이름의 서버 설정은 교체하지 않습니다.

Personal을 기본값으로 유지하면서 GitHub 저장소를 허용하려면 **대신** 다음과 같이 등록합니다:

```bash
pi mcp add room --exposure direct \
  --env CLOUDROOM_ALLOWED_GITHUB_REPOS=owner/repository \
  -- node /absolute/path/to/cloudroom-mcp/server.mjs
pi mcp list
```

해당 저장소를 기본값으로 쓰려면 대신 `--env CLOUDROOM_GITHUB_REPO=owner/repository`를 지정합니다.
다른 서버 설정도 반복 가능한 `--env`로 전달할 수 있습니다.
.env 파일을 쓸 때는 `node` 다음, 스크립트 경로 앞에 `--env-file=/absolute/path/to/cloudroom-mcp/.env`를 넣어도 됩니다.

### 2. 기존 Pi 세션에서 확인

Pi 외부에서 서버를 등록하거나 설정을 바꾼 뒤에는:

```text
/reload
/mcp
```

`room`이 연결되었고 네 도구가 모두 나타나는지 확인합니다.
Pi에서는 이름에 prefix가 붙어 `mcp__room__thread_spawn`, `mcp__room__thread_tell`,
`mcp__room__thread_get`, `mcp__room__thread_stop`으로 노출됩니다.
`pi mcp list`는 설정된 모든 서버의 연결과 오류를 확인하며, 에이전트 작업을 실행하지는 않습니다.

### 3. 직접 편집 또는 프로젝트별 설정

직접 설정하려면 Pi 전용 `mcp.example.json` entry를 `~/.pi/agent/mcp.json`에 병합하고
서버 경로를 바꾼 뒤 `/reload`하세요. 샘플에는 Pi의 `exposure: "direct"`와 60초 `timeout`이 포함되어 있습니다.

프로젝트별 등록은 **작업할 코딩 프로젝트 디렉터리에서** `pi mcp add room --local ...`로 실행합니다.
설정은 MCP 서버 설치 디렉터리가 아니라 그 작업 프로젝트의 `.pi/mcp.json`에 저장됩니다.
프로젝트별 MCP 설정은 Pi에서 해당 프로젝트를 신뢰한 뒤에만 로드됩니다.

### 문제 해결

- `node`를 찾지 못함: 등록 명령의 Node 실행 파일을 절대 경로로 지정하세요.
- `room-cli`가 없거나 실행 불가: 실제 실행 파일의 절대 경로를 `CLOUDROOM_CLI_PATH`로 설정하세요.
- Cloudroom에 연결할 수 없음: 로컬 제어 서버를 실행하고 `CLOUDROOM_SERVER_URL`을 확인하세요.
- `repository_not_allowed`: `CLOUDROOM_ALLOWED_GITHUB_REPOS` 또는 `CLOUDROOM_GITHUB_REPO`를 설정하고 새로고침하세요.
- `pi mcp add`를 지원하지 않음: `pi mcp add --help`를 확인하고 내장 MCP를 지원하는 Pi 버전을 사용하세요.

## GitHub 소스와 비범위

이 어댑터는 로컬 cloned repo나 미커밋 파일을 Cloud로 보내지 않습니다.
Personal에는 저장소와 branch가 필요 없습니다. 저장소 프로젝트에서 관찰한 Cloud 초기화는 GitHub clone 방식이며,
선택적인 `base_branch`는 원격에 있는 ref를 지정합니다.
로컬에서 개발 중인 변경분을 전달하려는 경우에만 GitHub push 등이 필요합니다.
기존 Cloud 스레드에 follow-up을 보낼 때마다 push하는 것은 아닙니다.
로컬 실행·로컬 소스 동기화는 후순위 기능으로 남겨둡니다.

## 검증

```bash
npm run check
npm test
npm audit --omit=dev
```

테스트는 fake room-cli를 사용하며 **유료 Cloud 작업을 자동 생성하지 않습니다.**
argv/문맥 분리, 엄격한 GitHub 식별자, 저장소 조회·등록과 허용 목록, 설정 변경 순서,
오류/타임아웃/취소, redirect 차단, 중복 자동 재시도 방지, 잠금, 이벤트 pagination,
실제 stdio MCP client와 legacy handshake를 검증합니다. 등록 통합 테스트는 실제 Cloudroom API 대신 로컬 가짜 HTTP 서버를 사용합니다.

초기 구현에서는 실제 Cloud 조회를 MCP client → server → room-cli 경로로 확인했습니다.
GitHub 등록 경로는 실제 등록 POST 대신 가짜 HTTP 서버로 검증합니다.
구현 검증을 위해 실제 프로젝트·스레드를 변경하거나 새 원격 작업을 실행하지 않습니다.
