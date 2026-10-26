use std::{
    collections::HashMap,
    fs,
    io::Read,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock, RwLockReadGuard,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

use crate::{
    Config, EXTENSION_ID, PORT, app_update, cookies::BrowserCookie, download, platform, services,
    tools::Tools,
};

#[derive(Clone, Deserialize, Serialize)]
pub struct VideoInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Job {
    pub id: String,
    pub url: String,
    pub title: String,
    pub format: String,
    pub start: f64,
    pub end: Option<f64>,
    pub status: String,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filenames: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct InfoState {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<VideoInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct State {
    pub tools: Value,
    pub info: HashMap<String, InfoState>,
    pub jobs: Vec<Job>,
    pub cancel: HashMap<String, Arc<AtomicBool>>,
    pub update: app_update::State,
    installation: Option<PathBuf>,
}

pub type Shared = Arc<Mutex<State>>;
type SharedTools = Arc<RwLock<Tools>>;

enum Task {
    Prepare,
    CheckUpdate {
        cancel: Arc<AtomicBool>,
    },
    Download {
        id: String,
        input: services::Request,
    },
}

pub fn serve(
    home: PathBuf,
    desktop: PathBuf,
    config: Config,
    control: &platform::Control,
) -> Result<()> {
    let server = Server::http(("127.0.0.1", PORT))
        .map_err(|error| anyhow::anyhow!("Cannot bind localhost:{PORT}: {error}"))?;
    let jobs_file = home.join("jobs.json");
    let mut jobs: Vec<Job> = fs::read(&jobs_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if let Err(error) = cleanup_stale(&home, &desktop, &jobs) {
        platform::log_error(&home, &format!("Clean up interrupted download: {error:#}"));
    }
    for job in &mut jobs {
        if !matches!(job.status.as_str(), "completed" | "failed" | "canceled") {
            job.status = "failed".into();
            job.error = Some("Загрузка прервана перезапуском. Добавьте её снова.".into());
        }
    }
    let installation = app_update::installation(&home);
    let update = if installation.is_some() {
        app_update::State::Idle
    } else {
        app_update::State::Disabled
    };
    let state = Arc::new(Mutex::new(State {
        tools: json!({"status":"checking"}),
        info: HashMap::new(),
        jobs,
        cancel: HashMap::new(),
        update,
        installation,
    }));
    let (sender, receiver) = mpsc::channel();
    let tools = Arc::new(RwLock::new(Tools::new(&home)?));
    let worker_tools = Arc::clone(&tools);
    let shared = Arc::clone(&state);
    let worker_home = home.clone();
    let worker_desktop = desktop.clone();
    thread::spawn(move || worker(receiver, shared, worker_tools, worker_home, worker_desktop));
    sender.send(Task::Prepare)?;
    let mut origins = vec![format!("chrome-extension://{}", EXTENSION_ID.trim())];
    origins.extend(
        config
            .additional_extension_ids
            .into_iter()
            .map(|id| format!("chrome-extension://{id}")),
    );
    let mut next_update = Instant::now();
    while !control.stopping(0)? {
        {
            let mut data = state.lock().unwrap();
            if matches!(data.update, app_update::State::Installing) {
                control.request_stop()?;
                break;
            }
            if (matches!(data.update, app_update::State::Idle) || Instant::now() >= next_update)
                && data.cancel.is_empty()
                && !data.info.values().any(|info| info.status == "loading")
                && data.tools["status"] != "checking"
                && matches!(
                    data.update,
                    app_update::State::Idle
                        | app_update::State::Current
                        | app_update::State::Failed(_)
                )
            {
                let cancel = Arc::new(AtomicBool::new(false));
                data.update = app_update::State::Checking(cancel.clone());
                sender.send(Task::CheckUpdate { cancel })?;
                next_update = Instant::now() + Duration::from_secs(6 * 3600);
            }
        }
        let Some(mut request) = server.recv_timeout(Duration::from_millis(150))? else {
            continue;
        };
        let origin = header(&request, "Origin").map(str::to_owned);
        let allowed_origin = origin
            .as_ref()
            .is_some_and(|origin| origins.contains(origin));
        let host_ok = header(&request, "Host").is_some_and(|host| {
            host == format!("127.0.0.1:{PORT}") || host == format!("localhost:{PORT}")
        });
        if !host_ok || (origin.is_some() && !allowed_origin) {
            respond(
                request,
                403,
                json!({"error":"Only the qcatch extension may use this bridge"}),
                None,
            );
            continue;
        }
        if request.method() == &Method::Options {
            let method = header(&request, "Access-Control-Request-Method").unwrap_or("");
            let headers = header(&request, "Access-Control-Request-Headers").unwrap_or("");
            let allowed_headers = headers.split(',').map(str::trim).all(|name| {
                matches!(
                    name.to_ascii_lowercase().as_str(),
                    "x-qcatch" | "content-type"
                )
            });
            if allowed_origin && matches!(method, "GET" | "POST") && allowed_headers {
                respond(request, 204, Value::Null, origin.as_deref());
            } else {
                respond(request, 403, json!({"error":"Origin not permitted"}), None);
            }
            continue;
        }
        if header(&request, "X-Qcatch") != Some("1") {
            respond(
                request,
                403,
                json!({"error":"Missing extension request header"}),
                origin.as_deref(),
            );
            continue;
        }
        let result = route(&mut request, &state, &tools, &sender, &home, &desktop);
        match result {
            Ok((code, value)) => respond(request, code, value, origin.as_deref()),
            Err(error) => respond(
                request,
                400,
                json!({"error":error.to_string()}),
                origin.as_deref(),
            ),
        }
    }
    state.lock().unwrap().update.cancel_check();
    for cancel in state.lock().unwrap().cancel.values() {
        cancel.store(true, Ordering::Relaxed);
    }
    persist(&state.lock().unwrap(), &home)?;
    Ok(())
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn respond(request: Request, status: u16, body: Value, origin: Option<&str>) {
    let mut response = Response::from_string(if status == 204 {
        String::new()
    } else {
        body.to_string()
    })
    .with_status_code(StatusCode(status));
    for (name, value) in [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("Vary", "Origin"),
    ] {
        response.add_header(Header::from_bytes(name, value).unwrap());
    }
    if let Some(origin) = origin {
        for (name, value) in [
            ("Access-Control-Allow-Origin", origin),
            ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
            ("Access-Control-Allow-Headers", "Content-Type, X-Qcatch"),
            ("Access-Control-Allow-Private-Network", "true"),
        ] {
            response.add_header(Header::from_bytes(name, value).unwrap());
        }
    }
    let _ = request.respond(response);
}

fn body<T: serde::de::DeserializeOwned>(request: &mut Request) -> Result<T> {
    ensure!(
        header(request, "Content-Type")
            .is_some_and(|value| value.split(';').next() == Some("application/json")),
        "Expected application/json"
    );
    ensure!(
        request.body_length().is_some_and(|length| length <= 65536),
        "Request body is too large or missing Content-Length"
    );
    let mut data = Vec::new();
    request.as_reader().take(65537).read_to_end(&mut data)?;
    ensure!(data.len() <= 65536, "Request body is too large");
    serde_json::from_slice(&data).context("Invalid request JSON")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InfoRequest {
    url: String,
    #[serde(default)]
    retry: bool,
    cookies: Vec<BrowserCookie>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobRequest {
    url: String,
    format: String,
    start: f64,
    end: Option<f64>,
    cookies: Vec<BrowserCookie>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlayRequest {
    url: String,
    start: f64,
    cookies: Vec<BrowserCookie>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaRequest {
    url: String,
    headers: Vec<(String, String)>,
    audio: Vec<String>,
    subtitles: Vec<String>,
    cookies: Vec<BrowserCookie>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffRequest {
    uri: String,
}

fn public_media_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value)?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none(),
        "Недопустимый адрес медиа."
    );
    let host = url.host_str().context("Адрес медиа не содержит домен.")?;
    ensure!(
        host.contains('.') && !host.ends_with(".localhost") && !host.ends_with(".local"),
        "Недопустимый адрес медиа."
    );
    if let Ok(address) = host.parse::<std::net::Ipv4Addr>() {
        ensure!(
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_multicast()
                && !address.is_unspecified(),
            "Недопустимый адрес медиа."
        );
    }
    Ok(url.into())
}

fn route(
    request: &mut Request,
    state: &Shared,
    tools: &SharedTools,
    sender: &mpsc::Sender<Task>,
    home: &Path,
    desktop: &Path,
) -> Result<(u16, Value)> {
    let path = request.url().to_owned();
    if request.method() == &Method::Post && path != "/updates/apply" {
        state.lock().unwrap().update.cancel_check();
    }
    match (request.method(), path.as_str()) {
        (&Method::Get, "/health") => {
            let data = state.lock().unwrap();
            Ok((
                200,
                json!({
                    "protocol":1,
                    "version":env!("CARGO_PKG_VERSION"),
                    "desktopPath":desktop,
                    "tools":data.tools,
                    "qplayInstalled":crate::browser::application("qplay").is_some(),
                    "qbuttInstalled":crate::browser::application("qbutt").is_some(),
                    "update":data.update.snapshot(),
                }),
            ))
        }
        (&Method::Post, "/extension/setup") => {
            let input: Value = body(request)?;
            crate::browser::connect(input["browser"].as_str().context("Browser is required.")?)?;
            Ok((200, json!({"opened":true})))
        }
        (&Method::Post, "/updates/apply") => {
            let _: Value = body(request)?;
            let mut data = state.lock().unwrap();
            if !data.cancel.is_empty() || data.info.values().any(|info| info.status == "loading") {
                return Ok((200, json!({"accepted":false})));
            }
            let (app_update::State::Ready(update), Some(install)) =
                (&data.update, &data.installation)
            else {
                return Ok((200, json!({"accepted":false})));
            };
            if let Err(error) = update.start(install) {
                let message = format!("{error:#}");
                data.update = app_update::State::Failed(message.clone());
                return Err(anyhow::anyhow!(message));
            }
            data.update = app_update::State::Installing;
            Ok((200, json!({"accepted":true})))
        }
        (&Method::Get, "/jobs") => {
            let mut data = state.lock().unwrap();
            let count = data.jobs.len();
            data.jobs.retain(|job| {
                job.status != "completed"
                    || job.filename.as_deref().is_some_and(|name| {
                        Path::new(name).components().count() == 1 && desktop.join(name).is_file()
                    }) && job.filenames.iter().all(|name| {
                        Path::new(name).components().count() == 1 && desktop.join(name).is_file()
                    })
            });
            if data.jobs.len() != count {
                persist(&data, home)?;
            }
            Ok((200, json!({"jobs":data.jobs})))
        }
        (&Method::Post, "/play") => {
            let input: PlayRequest = body(request)?;
            let url = canonical_url(&input.url)?;
            ensure!(
                input.start.is_finite() && input.start >= 0.0,
                "Неверная позиция воспроизведения"
            );
            crate::playback::launch(home, url, Some(input.start), input.cookies)?;
            Ok((200, json!({"opened":true,"start":input.start})))
        }
        (&Method::Post, "/services/play") => {
            let input: services::Request = body(request)?;
            services::watch(home, &input.url, input.cookies)?;
            Ok((200, json!({"opened":true})))
        }
        (&Method::Post, "/services/jobs") => {
            let input: services::Request = body(request)?;
            let reference = services::reference(&input.url)?;
            ensure!(
                !reference.live,
                "Use Watch for a Twitch live stream. Download is available for clips."
            );
            crate::cookies::CookieJar::validate_scope(&input.cookies, reference.domains)?;
            let mut data = state.lock().unwrap();
            if let Some(job) = data.jobs.iter().find(|job| {
                job.url == reference.url
                    && !matches!(job.status.as_str(), "completed" | "failed" | "canceled")
            }) {
                return Ok((200, serde_json::to_value(job)?));
            }
            ensure!(
                data.jobs
                    .iter()
                    .filter(|job| !matches!(
                        job.status.as_str(),
                        "completed" | "failed" | "canceled"
                    ))
                    .count()
                    < 25,
                "The download queue is full. Wait for a download to finish."
            );
            let job = Job {
                id: uuid::Uuid::new_v4().to_string(),
                url: reference.url,
                title: reference.service.into(),
                service: Some(reference.service.into()),
                format: "original".into(),
                start: 0.0,
                end: None,
                status: "queued".into(),
                progress: 0.0,
                filename: None,
                filenames: vec![],
                error: None,
            };
            data.cancel
                .insert(job.id.clone(), Arc::new(AtomicBool::new(false)));
            data.jobs.push(job.clone());
            if let Err(error) = persist(&data, home) {
                data.jobs.pop();
                data.cancel.remove(&job.id);
                return Err(error.context("Could not save the download queue."));
            }
            sender.send(Task::Download {
                id: job.id.clone(),
                input,
            })?;
            Ok((201, serde_json::to_value(job)?))
        }
        (&Method::Post, "/play-media") => {
            let input: MediaRequest = body(request)?;
            let url = public_media_url(&input.url)?;
            ensure!(
                input.audio.len() <= 16 && input.subtitles.len() <= 32 && input.headers.len() <= 32,
                "Слишком много дорожек или заголовков."
            );
            let audio = input
                .audio
                .iter()
                .map(|url| public_media_url(url))
                .collect::<Result<Vec<_>>>()?;
            let subtitles = input
                .subtitles
                .iter()
                .map(|url| public_media_url(url))
                .collect::<Result<Vec<_>>>()?;
            for (name, value) in &input.headers {
                ensure!(
                    !name.is_empty()
                        && !name.eq_ignore_ascii_case("cookie")
                        && name
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                        && name.len() <= 128
                        && value.len() <= 16384
                        && !value.contains(['\r', '\n', '\0']),
                    "Недопустимый заголовок запроса."
                );
            }
            crate::playback::open(crate::playback::Request {
                home: home.into(),
                url,
                headers: input.headers,
                audio,
                subtitles,
                cookies: input.cookies,
                extractor: None,
            })?;
            Ok((200, json!({"opened":true})))
        }
        (&Method::Post, "/handoff") => {
            use std::os::windows::process::CommandExt;
            let input: HandoffRequest = body(request)?;
            let uri = url::Url::parse(&input.uri)?;
            ensure!(
                input.uri.len() <= 24 * 1024
                    && uri.scheme() == "qbutt"
                    && uri.host_str() == Some("capture")
                    && uri
                        .query_pairs()
                        .any(|(key, value)| key == "d" && !value.is_empty()),
                "Недопустимая ссылка qbutt."
            );
            let executable =
                crate::browser::application("qbutt").context("qbutt не установлен.")?;
            std::process::Command::new(executable)
                .arg(&input.uri)
                .creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0)
                .spawn()?;
            Ok((200, json!({"opened":true})))
        }
        (&Method::Post, "/tools/retry") => {
            let _: Value = body(request)?;
            let mut data = state.lock().unwrap();
            if data.tools["status"] == "error" {
                data.tools = json!({"status":"checking"});
                sender.send(Task::Prepare)?;
            }
            Ok((
                200,
                json!({"protocol":1,"version":env!("CARGO_PKG_VERSION"),"desktopPath":desktop,"tools":data.tools,
                    "qplayInstalled":crate::browser::application("qplay").is_some(),
                    "qbuttInstalled":crate::browser::application("qbutt").is_some()}),
            ))
        }
        (&Method::Post, "/info") => {
            let input: InfoRequest = body(request)?;
            let url = canonical_url(&input.url)?;
            let mut data = state.lock().unwrap();
            let pending = data.info.get(&url);
            if pending.is_none()
                || (input.retry && pending.is_some_and(|info| info.status == "failed"))
            {
                ensure!(
                    data.info
                        .values()
                        .filter(|info| info.status == "loading")
                        .count()
                        < 8,
                    "Слишком много запросов. Подождите завершения подготовки."
                );
                if data.info.len() >= 100 {
                    data.info.retain(|_, info| info.status == "loading");
                }
                data.info.insert(
                    url.clone(),
                    InfoState {
                        status: "loading",
                        info: None,
                        error: None,
                    },
                );
                let state = Arc::clone(state);
                let tools = Arc::clone(tools);
                let url = url.clone();
                let home = home.to_owned();
                let cookies = input.cookies;
                thread::spawn(move || {
                    let result = current_tools(&tools, &state)
                        .and_then(|tools| download::info(&tools, &url, &home, &cookies));
                    let entry = match result {
                        Ok(info) => InfoState {
                            status: "ready",
                            info: Some(info),
                            error: None,
                        },
                        Err(error) => InfoState {
                            status: "failed",
                            info: None,
                            error: Some(error.to_string()),
                        },
                    };
                    state.lock().unwrap().info.insert(url, entry);
                });
            }
            Ok((200, serde_json::to_value(&data.info[&url])?))
        }
        (&Method::Post, "/jobs") => {
            let input: JobRequest = body(request)?;
            let url = canonical_url(&input.url)?;
            ensure!(
                matches!(input.format.as_str(), "mp4" | "mp3"),
                "Unsupported output format"
            );
            let mut data = state.lock().unwrap();
            let Some(info) = data
                .info
                .get(&url)
                .and_then(|entry| entry.info.as_ref())
                .cloned()
            else {
                return Ok((
                    409,
                    json!({"error":"Дождитесь загрузки информации о видео."}),
                ));
            };
            let end = input.end.unwrap_or(info.duration);
            ensure!(
                input.start.is_finite()
                    && end.is_finite()
                    && input.start >= 0.0
                    && input.start < end
                    && end <= info.duration,
                "Неверные границы фрагмента: начало должно быть раньше конца и внутри видео."
            );
            ensure!(
                data.jobs
                    .iter()
                    .filter(|job| !matches!(
                        job.status.as_str(),
                        "completed" | "failed" | "canceled"
                    ))
                    .count()
                    < 25,
                "Очередь заполнена. Дождитесь завершения загрузок."
            );
            let job = Job {
                id: uuid::Uuid::new_v4().to_string(),
                url,
                title: info.title,
                format: input.format,
                start: input.start,
                end: input.end,
                status: "queued".into(),
                progress: 0.0,
                filename: None,
                filenames: vec![],
                service: None,
                error: None,
            };
            data.cancel
                .insert(job.id.clone(), Arc::new(AtomicBool::new(false)));
            data.jobs.push(job.clone());
            if let Err(error) = persist(&data, home) {
                data.jobs.pop();
                data.cancel.remove(&job.id);
                return Err(error.context("Не удалось сохранить очередь загрузок"));
            }
            sender.send(Task::Download {
                id: job.id.clone(),
                input: services::Request {
                    url: job.url.clone(),
                    cookies: input.cookies,
                },
            })?;
            Ok((201, serde_json::to_value(job)?))
        }
        (&Method::Post, path) if path.starts_with("/jobs/") => {
            let _: Value = body(request)?;
            let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
            ensure!(parts.len() == 3, "Unknown endpoint");
            let mut data = state.lock().unwrap();
            let index = data
                .jobs
                .iter()
                .position(|job| job.id == parts[1])
                .context("Job not found")?;
            match parts[2] {
                "cancel" => {
                    if !matches!(
                        data.jobs[index].status.as_str(),
                        "completed" | "failed" | "canceled"
                    ) {
                        if let Some(cancel) = data.cancel.get(parts[1]) {
                            cancel.store(true, Ordering::Relaxed);
                        }
                        data.jobs[index].status = "canceling".into();
                    }
                    Ok((200, serde_json::to_value(&data.jobs[index])?))
                }
                "reveal" => {
                    ensure!(
                        data.jobs[index].status == "completed"
                            || !data.jobs[index].filenames.is_empty(),
                        "Download has not completed"
                    );
                    let name = data.jobs[index]
                        .filename
                        .as_ref()
                        .context("Output filename missing")?;
                    ensure!(
                        std::path::Path::new(name).components().count() == 1,
                        "Invalid output filename"
                    );
                    platform::reveal_file(&desktop.join(name))?;
                    Ok((200, json!({"ok":true})))
                }
                _ => bail!("Unknown endpoint"),
            }
        }
        _ => Ok((404, json!({"error":"Unknown endpoint"}))),
    }
}

pub fn canonical_url(input: &str) -> Result<String> {
    ensure!(input.len() <= 2048, "URL too long");
    let url = url::Url::parse(input).context("Invalid YouTube URL")?;
    ensure!(
        matches!(url.scheme(), "https" | "http")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none(),
        "Invalid YouTube URL"
    );
    let id = match url.host_str() {
        Some("youtu.be") => url.path().trim_start_matches('/').to_owned(),
        Some("youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com")
            if url.path() == "/watch" =>
        {
            url.query_pairs()
                .find(|(key, _)| key == "v")
                .map(|(_, value)| value.into_owned())
                .context("Missing video ID")?
        }
        Some("youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com")
            if url.path().starts_with("/shorts/") || url.path().starts_with("/live/") =>
        {
            url.path().split('/').nth(2).unwrap_or("").to_owned()
        }
        _ => bail!("Откройте отдельное видео YouTube или YouTube Music."),
    };
    ensure!(
        id.len() == 11
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'),
        "Invalid YouTube video ID"
    );
    Ok(format!("https://www.youtube.com/watch?v={id}"))
}

fn current_tools<'a>(tools: &'a SharedTools, state: &Shared) -> Result<RwLockReadGuard<'a, Tools>> {
    let current = tools.read().unwrap();
    if current.is_current() {
        return Ok(current);
    }
    drop(current);
    {
        let mut current = tools.write().unwrap();
        if !current.is_current() {
            state.lock().unwrap().tools =
                json!({"status":"checking","ytDlpVersion":current.version});
            let ready = current.ensure_latest();
            state.lock().unwrap().tools = match &ready {
                Ok(()) => json!({"status":"ready","ytDlpVersion":current.version}),
                Err(error) => {
                    json!({"status":"error","ytDlpVersion":current.version,"error":format!("Не удалось подготовить инструменты: {error}")})
                }
            };
            ready?;
        }
    }
    Ok(tools.read().unwrap())
}

fn worker(
    receiver: mpsc::Receiver<Task>,
    state: Shared,
    tools: SharedTools,
    home: PathBuf,
    desktop: PathBuf,
) {
    for task in receiver {
        match task {
            Task::Prepare => {
                drop(current_tools(&tools, &state));
            }
            Task::CheckUpdate { cancel } => {
                let result = app_update::prepare(&home, &cancel);
                let mut data = state.lock().unwrap();
                data.update = match result {
                    Err(error) => app_update::State::Failed(error.to_string()),
                    Ok(_) if cancel.load(Ordering::Acquire) => app_update::State::Idle,
                    Ok(Some(update)) => app_update::State::Ready(update),
                    Ok(None) => app_update::State::Current,
                };
            }
            Task::Download { id, input } => {
                let cancel = Arc::clone(&state.lock().unwrap().cancel[&id]);
                if cancel.load(Ordering::Relaxed) {
                    let mut data = state.lock().unwrap();
                    if let Some(job) = data.jobs.iter_mut().find(|job| job.id == id) {
                        job.status = "canceled".into();
                    }
                    data.cancel.remove(&id);
                    if let Err(error) = persist(&data, &home) {
                        platform::log_error(&home, &format!("Save download queue: {error:#}"));
                    }
                    continue;
                }
                let result = current_tools(&tools, &state).and_then(|tools| {
                    let service = state
                        .lock()
                        .unwrap()
                        .jobs
                        .iter()
                        .find(|job| job.id == id)
                        .is_some_and(|job| job.service.is_some());
                    if service {
                        services::download(&tools, &state, &home, &desktop, &id, &cancel, &input)
                    } else {
                        download::download(
                            &tools,
                            &state,
                            &home,
                            &desktop,
                            &id,
                            &cancel,
                            &input.cookies,
                        )
                        .map(|filename| vec![filename])
                    }
                });
                let cleanup_error = fs::remove_dir_all(home.join("temp").join(&id))
                    .err()
                    .filter(|error| error.kind() != std::io::ErrorKind::NotFound);
                let cleaned = cleanup_error.is_none();
                let result = cleanup_error.map_or(result, |error| {
                    Err(error).context("Could not remove temporary download files.")
                });
                let mut data = state.lock().unwrap();
                if let Some(job) = data.jobs.iter_mut().find(|job| job.id == id) {
                    match result {
                        Ok(filenames) => {
                            job.status = "completed".into();
                            job.progress = 1.0;
                            job.filename = filenames.first().cloned();
                            job.filenames = filenames;
                        }
                        Err(_) if cleaned && cancel.load(Ordering::Relaxed) => {
                            job.status = "canceled".into();
                        }
                        Err(error) => {
                            job.status = "failed".into();
                            job.error = Some(error.to_string());
                        }
                    }
                }
                data.cancel.remove(&id);
                if let Err(error) = persist(&data, &home) {
                    platform::log_error(&home, &format!("Save download queue: {error:#}"));
                }
            }
        }
    }
}

fn persist(data: &State, home: &Path) -> Result<()> {
    let staging = home.join("jobs.new.json");
    fs::write(&staging, serde_json::to_vec(&data.jobs)?)?;
    platform::replace_file(&staging, &home.join("jobs.json"))
}

fn cleanup_stale(home: &Path, desktop: &Path, jobs: &[Job]) -> Result<()> {
    let home = fs::canonicalize(home)?;
    crate::cookies::cleanup_playback(&home)?;
    crate::playback::cleanup_workers(&home)?;
    let temporary = home.join("temp");
    if let Ok(metadata) = fs::symlink_metadata(&temporary)
        && metadata.is_dir()
        && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0
    {
        let root = fs::canonicalize(&temporary)?;
        if root.parent() == Some(home.as_path()) {
            for entry in fs::read_dir(&root)?.take(1000) {
                let entry = entry?;
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if !uuid::Uuid::parse_str(name).is_ok_and(|id| id.to_string() == name) {
                    continue;
                }
                let metadata = fs::symlink_metadata(entry.path())?;
                if !metadata.is_dir()
                    || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
                {
                    continue;
                }
                let path = fs::canonicalize(entry.path())?;
                if path.parent() == Some(root.as_path()) {
                    // remove_dir_all does not follow directory symlinks or junctions.
                    fs::remove_dir_all(path)?;
                }
            }
        }
    }
    let parent = fs::canonicalize(
        desktop
            .parent()
            .context("Desktop has no parent directory")?,
    )?;
    for job in jobs {
        if !uuid::Uuid::parse_str(&job.id).is_ok_and(|id| id.to_string() == job.id) {
            continue;
        }
        let path = parent.join(format!(".qcatch-{}.partial", job.id));
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            continue;
        }
        let path = fs::canonicalize(path)?;
        if path.parent() == Some(parent.as_path()) {
            if metadata.is_dir() {
                fs::remove_dir_all(path)?;
            } else if metadata.is_file() {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}
