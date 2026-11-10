//! A minimal HTTP/1.1 server for the dev shim: one thread per connection, one request per
//! connection (every answer says `Connection: close`).
//!
//! tiny_http hands connections to a small pool of threads, and a burst of connections can
//! leave some queued behind threads that sit on keep-alive connections for good; their
//! requests are accepted and never answered, so a page stays on its start-up screen. A thread
//! per connection cannot queue, and a closed connection cannot be reused by the browser.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;

/// One parsed request: its method, target (path and query), headers as sent, and body.
pub struct Request {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// One answer: a status, its headers and its body.
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// A parsed request waiting for the serving loop, with the way back to its connection.
pub type Pending = (Request, Sender<Response>);

/// The most a request body may be; a dev shim has no use for more.
const MAX_BODY: usize = 64 * 1024 * 1024;

/// Accepts connections on `listener` and returns the queue of their requests. The caller
/// answers each through its sender, one at a time, on a thread of its choosing.
pub fn listen(listener: TcpListener) -> Receiver<Pending> {
    let (queue, requests) = channel::<Pending>();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let queue = queue.clone();
            std::thread::spawn(move || connection(stream, &queue));
        }
    });
    requests
}

fn connection(mut stream: TcpStream, queue: &Sender<Pending>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    let (reply, answer) = channel();
    if queue.send((request, reply)).is_err() {
        return;
    }
    let Ok(response) = answer.recv() else {
        return;
    };
    let _ = write_response(&mut stream, &response);
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let url = parts.next()?.to_owned();

    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':')?;
        headers.push((name.trim().to_owned(), value.trim().to_owned()));
    }

    let length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_BODY {
        return None;
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        url,
        headers,
        body,
    })
}

fn write_response(stream: &mut TcpStream, response: &Response) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        reason(response.status),
        response.body.len()
    );
    for (name, value) in &response.headers {
        // A header with a line break in it would split the response; skip it.
        if !name.contains(['\r', '\n']) && !value.contains(['\r', '\n']) {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&response.body)?;
    stream.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        409 => "Conflict",
        423 => "Locked",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "Status",
    }
}
