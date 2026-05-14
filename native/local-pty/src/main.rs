use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum InputFrame {
    Spawn {
        #[serde(rename = "shellPath")]
        shell_path: String,
        #[serde(rename = "shellArgs")]
        #[serde(default)]
        shell_args: Vec<String>,
        cwd: Option<String>,
        env: Option<HashMap<String, Option<String>>>,
        rows: Option<u16>,
        cols: Option<u16>,
    },
    Input {
        data: String,
    },
    Resize {
        rows: u16,
        cols: u16,
    },
    Kill,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum OutputFrame<'a> {
    Ready,
    Data { data: &'a str },
    Exit { code: u32 },
    Error { message: String },
}

fn main() {
    if let Err(error) = run() {
        let _ = emit_error(&error.to_string());
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let spawn = read_spawn_frame(&mut lines)?;
    let mut cmd = CommandBuilder::new(&spawn.shell_path);
    cmd.args(&spawn.shell_args);
    if let Some(cwd) = spawn.cwd.as_deref().filter(|cwd| !cwd.trim().is_empty()) {
        cmd.cwd(cwd);
    }
    if let Some(env) = spawn.env {
        for (key, value) in env {
            match value {
                Some(value) => cmd.env(key, value),
                None => cmd.env_remove(key),
            }
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: spawn.rows.unwrap_or(24),
        cols: spawn.cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .with_context(|| format!("failed to spawn shell {}", spawn.shell_path))?;
    let mut killer = child.clone_killer();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let reader_stdout = Arc::clone(&stdout);
    let _reader_thread = thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let data = BASE64.encode(&buffer[..count]);
                    let _ = emit_frame(&reader_stdout, &OutputFrame::Data { data: &data });
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });

    emit_frame(&stdout, &OutputFrame::Ready)?;

    let wait_stdout = Arc::clone(&stdout);
    let wait_thread = thread::spawn(move || {
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        let _ = emit_frame(&wait_stdout, &OutputFrame::Exit { code });
    });

    for line in lines {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<InputFrame>(&line)? {
            InputFrame::Input { data } => {
                let bytes = BASE64.decode(data.as_bytes())?;
                writer.write_all(&bytes)?;
                writer.flush()?;
            }
            InputFrame::Resize { rows, cols } => {
                pair.master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
            }
            InputFrame::Kill => {
                let _ = killer.kill();
                break;
            }
            InputFrame::Spawn { .. } => {
                return Err(anyhow!("unexpected duplicate spawn frame"));
            }
        }
    }

    let _ = killer.kill();
    let _ = wait_thread.join();
    Ok(())
}

struct SpawnFrame {
    shell_path: String,
    shell_args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, Option<String>>>,
    rows: Option<u16>,
    cols: Option<u16>,
}

fn read_spawn_frame<I>(lines: &mut I) -> Result<SpawnFrame>
where
    I: Iterator<Item = io::Result<String>>,
{
    for line in lines {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        return match serde_json::from_str::<InputFrame>(&line)? {
            InputFrame::Spawn {
                shell_path,
                shell_args,
                cwd,
                env,
                rows,
                cols,
            } => Ok(SpawnFrame {
                shell_path,
                shell_args,
                cwd,
                env,
                rows,
                cols,
            }),
            _ => Err(anyhow!("first frame must be spawn")),
        };
    }
    Err(anyhow!("missing spawn frame"))
}

fn emit_error(message: &str) -> Result<()> {
    let stdout = Arc::new(Mutex::new(io::stdout()));
    emit_frame(
        &stdout,
        &OutputFrame::Error {
            message: message.to_owned(),
        },
    )
}

fn emit_frame(stdout: &Arc<Mutex<io::Stdout>>, frame: &OutputFrame<'_>) -> Result<()> {
    let mut stdout = stdout.lock().map_err(|_| anyhow!("stdout lock poisoned"))?;
    serde_json::to_writer(&mut *stdout, frame)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typescript_spawn_frame_field_names() {
        let frame: InputFrame = serde_json::from_str(
            r#"{"type":"spawn","shellPath":"/bin/bash","shellArgs":["--login"],"rows":24,"cols":80}"#,
        )
        .expect("spawn frame should parse");

        match frame {
            InputFrame::Spawn {
                shell_path,
                shell_args,
                rows,
                cols,
                ..
            } => {
                assert_eq!(shell_path, "/bin/bash");
                assert_eq!(shell_args, vec!["--login".to_owned()]);
                assert_eq!(rows, Some(24));
                assert_eq!(cols, Some(80));
            }
            _ => panic!("expected spawn frame"),
        }
    }
}
