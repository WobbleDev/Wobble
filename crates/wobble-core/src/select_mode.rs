//! Per-value select modes (ADR 0043): which sub-values of one group a Worker may hold.
//!
//! A group is the sub-values of one answer, or an Attribute's top-level answers. The
//! Attribute's kind governs the top level (`category` is Single-Select, `tag` Multi-Select);
//! an answer with sub-values carries its own `mode`, or follows the Attribute's kind when it
//! has none. A Single-Select group allows held answers in at most one of its branches.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::attribute_migration::StoredAnswer;

pub const SINGLE: &str = "single";
pub const MULTI: &str = "multi";

/// The mode an Attribute kind gives its top level and its unmoded answers.
pub fn kind_mode(kind: &str) -> &'static str {
    if kind == "tag" {
        MULTI
    } else {
        SINGLE
    }
}

/// Whether `mode` is one of the two accepted wire values.
pub fn is_mode(mode: &str) -> bool {
    mode == SINGLE || mode == MULTI
}

fn children_by_parent(options: &[StoredAnswer]) -> HashMap<Option<&str>, Vec<&StoredAnswer>> {
    let mut children: HashMap<Option<&str>, Vec<&StoredAnswer>> = HashMap::new();
    for answer in options {
        children
            .entry(answer.parent_id.as_deref())
            .or_default()
            .push(answer);
    }
    children
}

/// Whether a Single-Select Attribute can hold several answers: some answer with sub-values
/// is explicitly Multi-Select. A Multi-Select Attribute always stores a list.
pub fn stores_a_list(kind: &str, options: &[StoredAnswer]) -> bool {
    if kind == "tag" {
        return true;
    }
    let children = children_by_parent(options);
    options.iter().any(|answer| {
        answer.mode.as_deref() == Some(MULTI) && children.contains_key(&Some(answer.id.as_str()))
    })
}

/// The answer ids as the Attribute stores them: a string for a Single-Select Attribute with
/// no Multi-Select group, a list otherwise.
pub fn shape_value(kind: &str, options: &[StoredAnswer], ids: &[String]) -> Value {
    if stores_a_list(kind, options) {
        Value::Array(ids.iter().cloned().map(Value::String).collect())
    } else {
        Value::String(ids.first().cloned().unwrap_or_default())
    }
}

/// The answer ids a stored value holds, whatever its shape: `''`, `null` and non-text
/// entries hold nothing.
pub fn held_ids(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) if !text.is_empty() => vec![text.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

/// Splits `ids` into those a Worker keeps and those the group modes drop: in each
/// Single-Select group the first branch in answer order that holds anything stays, together
/// with the group's parent if held, and held answers in the other branches go. Ids that are
/// not answers of the Attribute are kept untouched; the caller validates them separately.
pub fn enforce_modes(
    kind: &str,
    options: &[StoredAnswer],
    ids: &[String],
) -> (Vec<String>, Vec<String>) {
    let children = children_by_parent(options);
    let known: HashSet<&str> = options.iter().map(|answer| answer.id.as_str()).collect();
    let mut kept: HashSet<&str> = ids
        .iter()
        .map(String::as_str)
        .filter(|id| known.contains(id))
        .collect();
    let mut dropped: HashSet<&str> = HashSet::new();

    // Held answers in the branch rooted at `root`, including the root itself.
    fn held_in<'a>(
        root: &'a str,
        children: &HashMap<Option<&'a str>, Vec<&'a StoredAnswer>>,
        kept: &HashSet<&'a str>,
        out: &mut Vec<&'a str>,
    ) {
        if kept.contains(root) {
            out.push(root);
        }
        for child in children.get(&Some(root)).into_iter().flatten() {
            held_in(&child.id, children, kept, out);
        }
    }

    let mut groups: Vec<(Option<&str>, &str)> = vec![(None, kind_mode(kind))];
    while let Some((parent, mode)) = groups.pop() {
        let branches: &[&StoredAnswer] = children.get(&parent).map_or(&[], Vec::as_slice);
        if mode == SINGLE {
            let mut keeper_seen = false;
            for branch in branches {
                let mut held = Vec::new();
                held_in(&branch.id, &children, &kept, &mut held);
                // The group's parent is not a branch; only branches with held answers compete.
                if held.is_empty() {
                    continue;
                }
                if keeper_seen {
                    for id in held {
                        kept.remove(id);
                        dropped.insert(id);
                    }
                } else {
                    keeper_seen = true;
                }
            }
        }
        for branch in branches {
            if children.contains_key(&Some(branch.id.as_str())) {
                let own = branch.mode.as_deref().unwrap_or(kind_mode(kind));
                groups.push((Some(branch.id.as_str()), own));
            }
        }
    }

    let keep = |id: &String| !dropped.contains(id.as_str());
    (
        ids.iter().filter(|id| keep(id)).cloned().collect(),
        ids.iter().filter(|id| !keep(id)).cloned().collect(),
    )
}

/// What a Worker keeps of `ids` under the Attribute: the group modes' keepers for an
/// Attribute that stores a list, and the first of them for one that stores a single id.
pub fn resolve_ids(
    kind: &str,
    options: &[StoredAnswer],
    ids: &[String],
) -> (Vec<String>, Vec<String>) {
    let (mut kept, mut dropped) = enforce_modes(kind, options, ids);
    if !stores_a_list(kind, options) && kept.len() > 1 {
        dropped.extend(kept.split_off(1));
    }
    (kept, dropped)
}

/// Whether holding `ids` breaks no Single-Select group.
pub fn respects_modes(kind: &str, options: &[StoredAnswer], ids: &[String]) -> bool {
    enforce_modes(kind, options, ids).1.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(id: &str, parent: Option<&str>, mode: Option<&str>) -> StoredAnswer {
        StoredAnswer {
            id: id.to_owned(),
            value: id.to_owned(),
            parent_id: parent.map(str::to_owned),
            mode: mode.map(str::to_owned),
            short_form: None,
            short_form_origin: None,
            merged_into: None,
        }
    }

    fn ids(items: &[&str]) -> Vec<String> {
        items.iter().map(|id| (*id).to_owned()).collect()
    }

    fn tree() -> Vec<StoredAnswer> {
        vec![
            answer("foh", None, Some("multi")),
            answer("server", Some("foh"), None),
            answer("host", Some("foh"), None),
            answer("boh", None, Some("single")),
            answer("cook", Some("boh"), None),
            answer("dish", Some("boh"), None),
        ]
    }

    #[test]
    fn a_multi_group_inside_a_single_attribute_holds_several_branches() {
        let options = tree();
        assert!(respects_modes(
            "category",
            &options,
            &ids(&["server", "host"])
        ));
        assert!(stores_a_list("category", &options));
    }

    #[test]
    fn the_attribute_kind_governs_the_top_level() {
        let options = tree();
        assert!(!respects_modes(
            "category",
            &options,
            &ids(&["server", "cook"])
        ));
        assert!(respects_modes("tag", &options, &ids(&["server", "cook"])));
    }

    #[test]
    fn a_single_group_keeps_the_first_branch_in_order() {
        let options = tree();
        let (kept, dropped) = enforce_modes("tag", &options, &ids(&["dish", "cook"]));
        assert_eq!(kept, ids(&["cook"]));
        assert_eq!(dropped, ids(&["dish"]));
    }

    #[test]
    fn a_held_parent_stays_beside_one_branch() {
        let options = tree();
        let (kept, dropped) = enforce_modes("tag", &options, &ids(&["boh", "dish"]));
        assert_eq!(kept, ids(&["boh", "dish"]));
        assert!(dropped.is_empty());
    }

    #[test]
    fn a_mode_free_answer_follows_the_attribute_kind() {
        let options = vec![
            answer("a", None, None),
            answer("a1", Some("a"), None),
            answer("a2", Some("a"), None),
        ];
        assert!(!respects_modes("category", &options, &ids(&["a1", "a2"])));
        assert!(respects_modes("tag", &options, &ids(&["a1", "a2"])));
        assert!(!stores_a_list("category", &options));
    }

    #[test]
    fn a_dropped_branch_takes_its_deeper_answers_and_their_groups_with_it() {
        let options = vec![
            answer("a", None, None),
            answer("b", None, None),
            answer("b1", Some("b"), Some("multi")),
            answer("b1x", Some("b1"), None),
        ];
        let (kept, dropped) = enforce_modes("category", &options, &ids(&["a", "b1", "b1x"]));
        assert_eq!(kept, ids(&["a"]));
        assert_eq!(dropped, ids(&["b1", "b1x"]));
    }

    #[test]
    fn shape_follows_whether_the_attribute_can_hold_a_list() {
        let plain = vec![answer("a", None, None)];
        assert_eq!(
            shape_value("category", &plain, &ids(&["a"])),
            Value::from("a")
        );
        assert_eq!(shape_value("category", &plain, &[]), Value::from(""));
        assert_eq!(
            shape_value("tag", &plain, &ids(&["a"])),
            serde_json::json!(["a"])
        );
        assert_eq!(
            shape_value("category", &tree(), &ids(&["server"])),
            serde_json::json!(["server"])
        );
    }

    #[test]
    fn held_ids_reads_both_shapes() {
        assert_eq!(held_ids(&Value::from("x")), ids(&["x"]));
        assert_eq!(held_ids(&Value::from("")), Vec::<String>::new());
        assert_eq!(held_ids(&serde_json::json!(["x", "y"])), ids(&["x", "y"]));
        assert_eq!(held_ids(&Value::Null), Vec::<String>::new());
    }
}
