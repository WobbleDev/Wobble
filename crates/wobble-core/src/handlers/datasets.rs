//! The dataset route: the whole worksite for the Active Worksite in one reply.

use serde::Serialize;

use crate::agitation_persistence::{get_agitations, Agitation};
use crate::app_settings::{get_app_settings, AppSettings};
use crate::assembly::Worker;
use crate::attribute_migration::WorkerAttributeDefinition;
use crate::attribute_persistence::get_worker_attributes;
use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::language_persistence::{get_languages, Language};
use crate::request_worksite::resolve_request_worksite;
use crate::router::json_response;
use crate::schema::Worksite;
use crate::service::get_workers;
use crate::worksite_persistence::list_worksites;

/// Success body for `GET /api/dataset`: the whole worksite in one reply.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct DatasetReply {
    workers: Vec<Worker>,
    attributes: Vec<WorkerAttributeDefinition>,
    agitations: Vec<Agitation>,
    languages: Vec<Language>,
    worksite: Option<Worksite>,
    worksites: Vec<Worksite>,
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    settings: AppSettings,
}

/// `GET /api/dataset` (src/routes/api/dataset/+server.ts:19-45). The whole worksite in
/// one reply: the read order is workers → attributes → agitations → languages, so a
/// corrupt store surfaces the same error the TS threw, and `attributes` is the Worksite's
/// *definitions*. Without an Active Worksite the four Worksite-scoped collections are
/// empty and `worksite` is null, while `worksites` and `settings` stay populated.
pub(crate) fn get_dataset(db: &Db, request: &Request) -> Result<Response> {
    let worksite = resolve_request_worksite(db.conn(), request)?;
    let worksites = list_worksites(db.conn())?;
    let settings = get_app_settings(db.conn())?;

    let (workers, attributes, agitations, languages) = match &worksite {
        Some(worksite) => (
            get_workers(db.conn(), Some(worksite))?,
            get_worker_attributes(db.conn(), &Some(worksite.clone()))?,
            get_agitations(db.conn(), &Some(worksite.clone()))?,
            get_languages(db.conn(), &Some(worksite.clone()))?,
        ),
        None => (Vec::new(), Vec::new(), Vec::new(), Vec::new()),
    };

    Ok(json_response(
        200,
        serde_json::to_value(DatasetReply {
            workers,
            attributes,
            agitations,
            languages,
            worksite,
            worksites,
            settings,
        })?,
    ))
}
