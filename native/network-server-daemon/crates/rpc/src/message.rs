//! Request and response shapes.
//!
//! Normative definition: `docs/network-server-daemon-protocol.md` §2.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Machine-readable error classification. Closed set, per protocol §2.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    NotFound,
    MethodNotFound,
    InvalidParams,
    InvalidRequest,
    NotImplemented,
    InternalError,
}

impl ErrorCode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::MethodNotFound => "METHOD_NOT_FOUND",
            Self::InvalidParams => "INVALID_PARAMS",
            Self::InvalidRequest => "INVALID_REQUEST",
            Self::NotImplemented => "NOT_IMPLEMENTED",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }
}

/// A validated inbound request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub id: i64,
    pub method: String,
    /// Always an object. An absent `params` becomes an empty one, so callers
    /// never have to distinguish "absent" from "empty" — the protocol says they
    /// are equivalent.
    pub params: Map<String, Value>,
}

/// Why a line could not be turned into a [`Request`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestError {
    /// Not JSON at all.
    NotJson(String),
    /// JSON, but not a request: no numeric `id`, or no string `method`, or
    /// `params` that is not an object.
    ///
    /// Deliberately *not* answerable. There is no usable id to answer to, and
    /// inventing one risks resolving a pending call that belongs to a different
    /// request entirely.
    Malformed(&'static str),
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotJson(detail) => write!(f, "invalid JSON: {detail}"),
            Self::Malformed(detail) => write!(f, "malformed request: {detail}"),
        }
    }
}

/// The permissive shape a line is first decoded into, so that a bad field can be
/// reported precisely instead of as a generic deserialisation failure.
#[derive(Debug, Deserialize)]
struct RawRequest {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<Value>,
    #[serde(default)]
    params: Option<Value>,
}

impl Request {
    /// Parses and validates one line.
    pub fn parse(line: &str) -> Result<Self, RequestError> {
        let raw: RawRequest =
            serde_json::from_str(line).map_err(|e| RequestError::NotJson(e.to_string()))?;
        let id = match raw.id {
            // `as_i64` rejects a fractional or out-of-range number, which the
            // host never sends and which could not be echoed back faithfully.
            Some(Value::Number(n)) => n.as_i64().ok_or(RequestError::Malformed("id is not an integer"))?,
            _ => return Err(RequestError::Malformed("id is missing or not a number")),
        };
        let method = match raw.method {
            Some(Value::String(s)) if !s.is_empty() => s,
            _ => return Err(RequestError::Malformed("method is missing or not a string")),
        };
        let params = match raw.params {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(map)) => map,
            Some(_) => return Err(RequestError::Malformed("params is not an object")),
        };
        Ok(Self { id, method, params })
    }

    /// Reads a required string parameter.
    pub fn string_param(&self, name: &str) -> Result<&str, ErrorCode> {
        match self.params.get(name) {
            Some(Value::String(s)) => Ok(s),
            _ => Err(ErrorCode::InvalidRequest),
        }
    }

    /// Reads an optional object parameter.
    #[must_use]
    pub fn object_param(&self, name: &str) -> Option<&Map<String, Value>> {
        self.params.get(name).and_then(Value::as_object)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// Everything the daemon writes to stdout.
///
/// `untagged` so each variant serialises to its own bare object shape. Every
/// payload field is a `Value` rather than an `Option`, because the host
/// discriminates on **key presence**: a serialiser that skipped a null `result`
/// or a null `data` would produce messages the host silently drops. Protocol
/// §1.2 states this; the tests below pin it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Outgoing {
    Result { id: i64, result: Value },
    Error { id: i64, error: ErrorBody },
    Event { event: String, data: Value },
}

impl Outgoing {
    #[must_use]
    pub fn result(id: i64, result: Value) -> Self {
        Self::Result { id, result }
    }

    #[must_use]
    pub fn error(id: i64, code: ErrorCode, message: impl Into<String>) -> Self {
        Self::Error {
            id,
            error: ErrorBody {
                code: code.as_str().to_owned(),
                message: message.into(),
            },
        }
    }

    #[must_use]
    pub fn event(event: impl Into<String>, data: Value) -> Self {
        Self::Event {
            event: event.into(),
            data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_well_formed_request_parses() {
        let r = Request::parse(r#"{"id":7,"method":"start","params":{"id":"tftp"}}"#).unwrap();
        assert_eq!(r.id, 7);
        assert_eq!(r.method, "start");
        assert_eq!(r.string_param("id").unwrap(), "tftp");
    }

    #[test]
    fn absent_and_null_params_are_both_an_empty_object() {
        for line in [r#"{"id":1,"method":"list"}"#, r#"{"id":1,"method":"list","params":null}"#] {
            let r = Request::parse(line).unwrap();
            assert!(r.params.is_empty());
        }
    }

    #[test]
    fn a_request_without_a_usable_id_is_not_answerable() {
        for line in [
            r#"{"method":"list"}"#,
            r#"{"id":"7","method":"list"}"#,
            r#"{"id":1.5,"method":"list"}"#,
            r#"{"id":null,"method":"list"}"#,
        ] {
            assert!(
                matches!(Request::parse(line), Err(RequestError::Malformed(_))),
                "{line} must not parse"
            );
        }
    }

    #[test]
    fn a_request_without_a_method_is_malformed() {
        assert!(matches!(
            Request::parse(r#"{"id":1}"#),
            Err(RequestError::Malformed(_))
        ));
        assert!(matches!(
            Request::parse(r#"{"id":1,"method":""}"#),
            Err(RequestError::Malformed(_))
        ));
    }

    #[test]
    fn params_that_are_not_an_object_are_malformed() {
        assert!(matches!(
            Request::parse(r#"{"id":1,"method":"list","params":[1,2]}"#),
            Err(RequestError::Malformed(_))
        ));
    }

    #[test]
    fn non_json_is_reported_as_such() {
        assert!(matches!(Request::parse("not json"), Err(RequestError::NotJson(_))));
    }

    #[test]
    fn a_null_result_keeps_its_key() {
        // The host classifies a message as a response by testing for the
        // presence of `result`. Omitting a null one makes the response
        // unrecognisable and the caller's promise hangs until its timeout.
        let encoded = serde_json::to_value(Outgoing::result(3, Value::Null)).unwrap();
        assert_eq!(encoded, json!({"id": 3, "result": null}));
        assert!(encoded.as_object().unwrap().contains_key("result"));
    }

    #[test]
    fn the_ready_event_keeps_its_null_data_key() {
        let encoded = serde_json::to_value(Outgoing::event("ready", Value::Null)).unwrap();
        assert_eq!(encoded, json!({"event": "ready", "data": null}));
        assert!(encoded.as_object().unwrap().contains_key("data"));
    }

    #[test]
    fn an_error_response_carries_a_code_and_a_message() {
        let encoded =
            serde_json::to_value(Outgoing::error(9, ErrorCode::NotFound, "no such thing")).unwrap();
        assert_eq!(
            encoded,
            json!({"id": 9, "error": {"code": "NOT_FOUND", "message": "no such thing"}})
        );
    }

    #[test]
    fn a_result_and_an_error_are_never_both_present() {
        let encoded = serde_json::to_value(Outgoing::error(1, ErrorCode::InternalError, "x")).unwrap();
        assert!(!encoded.as_object().unwrap().contains_key("result"));
    }
}
