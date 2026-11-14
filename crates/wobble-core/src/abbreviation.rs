//! Short forms (ADR 0046): the stored compact name of an Attribute value, at most 10
//! graphemes, with its origin. This is the only place a Short form is produced or judged.

use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use crate::abbreviation_lists::{lists_for, Lists};

/// The most graphemes a Short form may hold.
pub const ABBREVIATION_LIMIT: usize = 10;
/// The origin of a form the core produced from the value's name.
pub const ORIGIN_GENERATED: &str = "generated";
/// The origin of a form the organizer wrote; it never changes by itself.
pub const ORIGIN_EDITED: &str = "edited";

/// Whether `origin` is one of the two accepted wire values.
pub fn is_origin(origin: &str) -> bool {
    origin == ORIGIN_GENERATED || origin == ORIGIN_EDITED
}

/// The length of `text` in user-perceived characters.
pub fn grapheme_count(text: &str) -> usize {
    text.graphemes(true).count()
}

/// `text` in Unicode normalisation form C, trimmed: the one spelling a Short form is
/// judged and stored in.
pub fn normalise(text: &str) -> String {
    text.nfc().collect::<String>().trim().to_owned()
}

/// Whether `form`, once normalised and trimmed, is an acceptable Short form: 1 to 10
/// graphemes.
pub fn is_valid(form: &str) -> bool {
    (1..=ABBREVIATION_LIMIT).contains(&grapheme_count(&normalise(form)))
}

fn fits(text: &str) -> bool {
    grapheme_count(text) <= ABBREVIATION_LIMIT
}

fn is_apostrophe(grapheme: &str) -> bool {
    grapheme == "'" || grapheme == "\u{2019}"
}

/// A name cut into runs of word characters and the separators between them. An apostrophe
/// between two letters belongs to the word ("Women's").
fn segments(name: &str) -> Vec<(bool, String)> {
    let graphemes: Vec<&str> = name.graphemes(true).collect();
    let is_alnum = |grapheme: &str| grapheme.chars().next().is_some_and(char::is_alphanumeric);
    let mut out: Vec<(bool, String)> = Vec::new();
    for (index, grapheme) in graphemes.iter().enumerate() {
        let inside_word = is_apostrophe(grapheme)
            && index > 0
            && is_alnum(graphemes[index - 1])
            && graphemes.get(index + 1).is_some_and(|next| is_alnum(next));
        let word = inside_word || is_alnum(grapheme);
        match out.last_mut() {
            Some((kind, text)) if *kind == word => text.push_str(grapheme),
            _ => out.push((word, (*grapheme).to_owned())),
        }
    }
    out
}

/// The words of a name for judging initials: a hyphen joins its two sides into one word
/// ("Self-Help"), so neither half is an initial of its own. Each word's `segments` index
/// range is kept too, so a sourced acronym's phrase match can be substituted back in.
fn words_with_spans(name: &str) -> Vec<(String, std::ops::RangeInclusive<usize>)> {
    let parts = segments(name);
    let mut out: Vec<(String, std::ops::RangeInclusive<usize>)> = Vec::new();
    let mut joined = false;
    for (index, (word, text)) in parts.iter().enumerate() {
        if *word {
            match out.last_mut() {
                Some((last, range)) if joined => {
                    last.push_str(text);
                    *range = *range.start()..=index;
                }
                _ => out.push((text.clone(), index..=index)),
            }
            joined = false;
        } else {
            joined =
                text == "-" && index > 0 && parts.get(index + 1).is_some_and(|(word, _)| *word);
        }
    }
    out
}

/// The words of a name for judging initials: a hyphen joins its two sides into one word
/// ("Self-Help"), so neither half is an initial of its own.
fn words(name: &str) -> Vec<String> {
    words_with_spans(name)
        .into_iter()
        .map(|(text, _)| text)
        .collect()
}

/// `name`'s words joined by a single space, lowercased: the key a sourced acronym's
/// expansion and a worksite value are compared by.
fn phrase_key(name: &str) -> String {
    words(name)
        .iter()
        .map(|word| word.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_listed(list: &[&str], word: &str) -> bool {
    let lower = word.to_lowercase();
    list.iter().any(|entry| *entry == lower)
}

/// The letters a word contributes to initials: a number stands for itself.
fn initial(word: &str) -> String {
    if word.chars().all(char::is_numeric) {
        word.to_owned()
    } else {
        word.chars().take(1).flat_map(char::to_uppercase).collect()
    }
}

/// A short form written into the name, "Name (ABC)", accepted only when its characters are
/// the initials of the words before it (with or without the connectors).
fn stated_form(lists: &Lists, name: &str) -> Option<String> {
    let body = name.strip_suffix(')')?;
    let (before, inner) = body.rsplit_once('(')?;
    let inner = inner.trim();
    if inner.is_empty() || !inner.chars().all(char::is_alphanumeric) {
        return None;
    }
    let before = words(before);
    let initials = |skip_connectors: bool| -> String {
        before
            .iter()
            .filter(|word| !(skip_connectors && is_listed(lists.connectors, word)))
            .map(|word| initial(word))
            .collect()
    };
    let wanted = inner.to_uppercase();
    (wanted == initials(false) || wanted == initials(true)).then(|| inner.to_owned())
}

/// A shortening in the case of the word it replaces.
fn with_case_of(word: &str, short: &str) -> String {
    let letters: Vec<char> = word.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() > 1 && letters.iter().all(|c| c.is_uppercase()) {
        short.to_uppercase()
    } else if letters.first().is_some_and(|c| c.is_uppercase()) {
        let mut chars = short.chars();
        chars
            .next()
            .map(|first| first.to_uppercase().chain(chars).collect())
            .unwrap_or_default()
    } else {
        short.to_owned()
    }
}

/// Every form that fits as `parts` is shortened word by word, the word with the largest
/// saving going first (the earliest on a tie), skipping any index already `done`. Shared by
/// plain word shortening and the acronym step's shortening of a phrase match's remainder.
fn shorten_parts(
    lists: &Lists,
    mut parts: Vec<(bool, String)>,
    mut done: Vec<bool>,
) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        let best = parts
            .iter()
            .enumerate()
            .filter(|(index, (word, _))| *word && !done[*index])
            .filter_map(|(index, (_, text))| {
                let lower = text.to_lowercase();
                let (_, short) = lists.words.iter().find(|(source, _)| *source == lower)?;
                let short = with_case_of(text, short);
                let saving = grapheme_count(text).checked_sub(grapheme_count(&short))?;
                (saving > 0).then_some((saving, index, short))
            })
            .max_by_key(|(saving, index, _)| (*saving, std::cmp::Reverse(*index)));
        let Some((_, index, short)) = best else {
            return out;
        };
        parts[index].1 = short;
        done[index] = true;
        let joined: String = parts.iter().map(|(_, text)| text.as_str()).collect();
        if fits(&joined) {
            out.push(joined);
        }
    }
}

/// Every form that fits, word by word: the word with the largest saving goes first (the
/// earliest on a tie), one at a time.
fn word_shortenings(lists: &Lists, name: &str) -> Vec<String> {
    let parts = segments(name);
    let done = vec![false; parts.len()];
    shorten_parts(lists, parts, done)
}

/// One whole-word phrase inside a name that a sourced acronym covers: the acronym, the
/// expansion phrase it matched (to find the acronym's other expansions), and every form
/// that fits once the phrase is replaced and the remaining words are shortened as far as
/// needed (unshortened first, if that already fits). Longest phrase first, leftmost on a
/// tie, so a whole-name match (the longest possible phrase) is tried before a sub-phrase.
fn acronym_match_forms(lists: &Lists, name: &str) -> Vec<(String, String, Vec<String>)> {
    let spans = words_with_spans(name);
    let parts = segments(name);
    let mut matches: Vec<(usize, usize, usize, String, &'static str)> = Vec::new();
    for start in 0..spans.len() {
        for end in start..spans.len() {
            let phrase = spans[start..=end]
                .iter()
                .map(|(text, _)| text.to_lowercase())
                .collect::<Vec<_>>()
                .join(" ");
            if let Some((expansion, acronym)) = lists
                .acronyms
                .iter()
                .find(|(expansion, _)| *expansion == phrase)
            {
                matches.push((
                    end - start + 1,
                    start,
                    end,
                    (*expansion).to_owned(),
                    *acronym,
                ));
            }
        }
    }
    matches.sort_by_key(|(len, start, ..)| (std::cmp::Reverse(*len), *start));
    matches
        .into_iter()
        .map(|(_, start, end, expansion, acronym)| {
            let part_start = *spans[start].1.start();
            let part_end = *spans[end].1.end();
            let mut new_parts = parts.clone();
            new_parts.splice(part_start..=part_end, [(true, acronym.to_owned())]);
            let mut done = vec![false; new_parts.len()];
            done[part_start] = true;
            let whole: String = new_parts.iter().map(|(_, text)| text.as_str()).collect();
            let mut forms = Vec::new();
            if fits(&whole) {
                forms.push(whole);
            }
            forms.extend(shorten_parts(lists, new_parts, done));
            (acronym.to_owned(), expansion, forms)
        })
        .collect()
}

/// Whether a sourced acronym `acronym`, used for `expansion`, is skipped because some value
/// in `worksite_values` (a) is `acronym`, (b) matches another of `acronym`'s expansions in
/// the lists, or (c) states `acronym` explicitly for something else (ADR 0046).
fn worksite_conflict(
    lists: &Lists,
    acronym: &str,
    expansion: &str,
    worksite_values: &[&str],
) -> bool {
    let target = acronym.to_lowercase();
    worksite_values.iter().any(|value| {
        let value = normalise(value);
        let key = phrase_key(&value);
        if key == target {
            return true;
        }
        let other_expansion = lists
            .acronyms
            .iter()
            .any(|(other_expansion, other_acronym)| {
                other_acronym.eq_ignore_ascii_case(acronym)
                    && *other_expansion != expansion
                    && *other_expansion == key
            });
        if other_expansion {
            return true;
        }
        stated_form(lists, &value).is_some_and(|stated| stated.eq_ignore_ascii_case(acronym))
    })
}

/// The combined forms of the first phrase match (longest, then leftmost) whose acronym
/// passes the worksite conflict check: ranked after a stated-in-name short form and before
/// plain word shortening. Empty when every match's acronym is skipped, so step 4 alone
/// follows.
fn acronym_forms(lists: &Lists, name: &str, worksite_values: &[&str]) -> Vec<String> {
    acronym_match_forms(lists, name)
        .into_iter()
        .find(|(acronym, expansion, _)| {
            !worksite_conflict(lists, acronym, expansion, worksite_values)
        })
        .map(|(_, _, forms)| forms)
        .unwrap_or_default()
}

/// Whether a stored generated `form` of `name` may be kept as is, rather than regenerated,
/// under the current lists and `worksite_values`. A name with no acronym phrase match at all
/// is always kept: word shortenings are not checked against other meanings. Otherwise: when
/// an acronym now passes the worksite conflict check, `form` must already be one of its
/// candidates, so an add, rename or merge that removes a conflict lets the next regeneration
/// use the newly free acronym; when none passes, `form` must not be a candidate any attempted
/// match would have produced, so one that newly conflicts is regenerated to its fallback.
fn acronym_resolution_ok(lists: &Lists, name: &str, form: &str, worksite_values: &[&str]) -> bool {
    let matches = acronym_match_forms(lists, name);
    let passing = matches
        .iter()
        .find(|(acronym, expansion, _)| {
            !worksite_conflict(lists, acronym, expansion, worksite_values)
        })
        .map(|(_, _, forms)| forms);
    match passing {
        Some(forms) => forms
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(form)),
        None => !matches.iter().any(|(_, _, forms)| {
            forms
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(form))
        }),
    }
}

/// Initials of a 3 or 4 word name: connectors skipped, only letters, no qualifier word.
fn initials_form(lists: &Lists, name: &str) -> Option<String> {
    let all = words(name);
    if all.iter().any(|word| {
        !word
            .chars()
            .all(|c| c.is_alphabetic() || matches!(c, '-' | '\'' | '\u{2019}'))
    }) || all.iter().any(|word| is_listed(lists.qualifiers, word))
    {
        return None;
    }
    let kept: Vec<&String> = all
        .iter()
        .filter(|word| !is_listed(lists.connectors, word))
        .collect();
    (3..=4)
        .contains(&kept.len())
        .then(|| kept.iter().map(|word| initial(word)).collect())
}

/// The forms a name can take, best first: each step the spec orders, the ones that fit.
/// `worksite_values` is every other value's name in the worksite, for the acronym step's
/// conflict check (ADR 0046); other steps ignore it.
fn candidates(lists: &Lists, name: &str, worksite_values: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if fits(name) {
        out.push(name.to_owned());
    }
    out.extend(stated_form(lists, name).filter(|form| fits(form)));
    out.extend(acronym_forms(lists, name, worksite_values));
    out.extend(word_shortenings(lists, name));
    out.extend(initials_form(lists, name));
    // The spec rule is literal: 9 graphemes and then the ellipsis, even when the
    // ninth grapheme is a space ("Rotating …"). Trimming the cut broke the reviewed
    // Agitations header expectation, so the space stays.
    if !fits(name) {
        let cut: String = name.graphemes(true).take(ABBREVIATION_LIMIT - 1).collect();
        out.push(format!("{cut}…"));
    }
    out
}

/// The generated Short form of a value name from `lists`: the first step that fits and is
/// not one of the `taken` forms of the Attribute's other values (compared without regard
/// to case). When every step collides, the best step stands. `worksite_values` is every
/// other value's name across the worksite's Attributes, for the acronym step's conflict
/// check.
pub fn generate_with(
    lists: &Lists,
    name: &str,
    taken: &[&str],
    worksite_values: &[&str],
) -> String {
    let name = normalise(name);
    let found = candidates(lists, &name, worksite_values);
    let is_free = |form: &&String| {
        !taken
            .iter()
            .any(|other| normalise(other).to_lowercase() == form.to_lowercase())
    };
    found
        .iter()
        .find(is_free)
        .or(found.first())
        .cloned()
        .unwrap_or_default()
}

/// The generated Short form of a value name under the lists of `locale`'s language.
pub fn generate(locale: &str, name: &str, taken: &[&str], worksite_values: &[&str]) -> String {
    generate_with(lists_for(locale), name, taken, worksite_values)
}

/// One value of an Attribute as a save presents it: its name, the form and origin the
/// request carries, and what the core already stores for it.
pub struct Entry<'a> {
    pub name: &'a str,
    pub form: Option<&'a str>,
    pub origin: Option<&'a str>,
    /// The stored name, form and origin of the same value, when it is already stored.
    pub stored: Option<(&'a str, &'a str, &'a str)>,
}

/// The Short form and origin of every value of one Attribute, in order. An edited form is
/// kept. A stored generated form is kept while `lists_current` holds, its name is
/// unchanged, it is still valid and unique, and (when it came from the acronym step) it
/// still passes the worksite conflict check against `worksite_values` (ADR 0046): an
/// unrelated save, reorder or insert moves nothing, a change of locale regenerates nothing,
/// but an add, rename or merge that makes a generated acronym ambiguous regenerates it, and
/// so does a bundled lists revision that no longer matches the one `lists_current` reports
/// (ticket 05) — every generated value regenerates once, and an edited one is never
/// touched. Every other value is generated, avoiding the forms already taken.
pub fn resolve_attribute(
    locale: &str,
    entries: &[Entry],
    worksite_values: &[&str],
    lists_current: bool,
) -> Vec<(String, String)> {
    let lists = lists_for(locale);
    let mut resolved: Vec<Option<String>> = vec![None; entries.len()];
    let mut taken: Vec<String> = Vec::new();
    let reserve = |taken: &mut Vec<String>, form: String| {
        taken.push(form.to_lowercase());
        form
    };
    for (index, entry) in entries.iter().enumerate() {
        if let (Some(form), Some(ORIGIN_EDITED)) = (entry.form, entry.origin) {
            resolved[index] = Some(reserve(&mut taken, normalise(form)));
        }
    }
    for (index, entry) in entries.iter().enumerate() {
        let Some((name, form, origin)) = entry.stored else {
            continue;
        };
        let unchanged = lists_current
            && origin == ORIGIN_GENERATED
            && resolved[index].is_none()
            && normalise(name) == normalise(entry.name);
        let form = normalise(form);
        // The acronym scan runs last, so edited and already-taken forms never pay for it.
        let keep = unchanged
            && is_valid(&form)
            && !taken.contains(&form.to_lowercase())
            && acronym_resolution_ok(lists, &normalise(entry.name), &form, worksite_values);
        if keep {
            resolved[index] = Some(reserve(&mut taken, form));
        }
    }
    let mut result = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let edited = matches!((entry.form, entry.origin), (Some(_), Some(ORIGIN_EDITED)));
        let form = match resolved[index].take() {
            Some(form) => form,
            None => {
                let others: Vec<&str> = taken.iter().map(String::as_str).collect();
                let form = generate(locale, entry.name, &others, worksite_values);
                reserve(&mut taken, form)
            }
        };
        let origin = if edited {
            ORIGIN_EDITED
        } else {
            ORIGIN_GENERATED
        };
        result.push((form, origin.to_owned()));
    }
    result
}

/// The Short form and origin a value is stored with. An edited form the request carries is
/// kept (normalised, trimmed); anything else is generated from the name, so a generated
/// form follows a rename. The request guard has already refused an edited form that is not
/// valid.
pub fn resolve(
    locale: &str,
    name: &str,
    form: Option<&str>,
    origin: Option<&str>,
    taken: &[&str],
    worksite_values: &[&str],
) -> (String, String) {
    match (form, origin) {
        (Some(form), Some(ORIGIN_EDITED)) => (normalise(form), ORIGIN_EDITED.to_owned()),
        _ => (
            generate(locale, name, taken, worksite_values),
            ORIGIN_GENERATED.to_owned(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abbreviation_lists::Lists;

    static FIXTURE: Lists = Lists {
        language: "xx",
        words: &[
            ("maintenance", "maint."),
            ("service", "svc."),
            ("customer", "cust."),
            ("warehouse", "whse"),
            ("night", "ngt"),
            ("administración", "admón."),
        ],
        connectors: &["of", "the"],
        qualifiers: &["north", "night", "temporary"],
        acronyms: &[],
    };

    fn gen(name: &str) -> String {
        generate_with(&FIXTURE, name, &[], &[])
    }

    static ACRONYM_FIXTURE: Lists = Lists {
        language: "xx",
        words: &[("maintenance", "maint."), ("resources", "res.")],
        connectors: &["of"],
        qualifiers: &[],
        acronyms: &[
            ("back of house", "BOH"),
            ("front of house", "FOH"),
            ("human resources", "HR"),
            ("public relations", "PR"),
            ("payroll", "PR"),
        ],
    };

    fn gen_acr(name: &str) -> String {
        generate_with(&ACRONYM_FIXTURE, name, &[], &[])
    }

    fn gen_acr_in(name: &str, worksite_values: &[&str]) -> String {
        generate_with(&ACRONYM_FIXTURE, name, &[], worksite_values)
    }

    #[test]
    fn a_name_that_fits_is_kept_whole() {
        assert_eq!(gen("Kitchen"), "Kitchen");
        assert_eq!(gen("0123456789"), "0123456789");
        assert_eq!(gen("  padded  "), "padded");
    }

    #[test]
    fn a_abbreviation_stated_in_the_name_is_taken_only_when_its_letters_are_the_initials() {
        assert_eq!(gen("Technical Advisory Board (TAB)"), "TAB");
        assert_eq!(gen("Ward 12 (W12)"), "W12");
        assert_eq!(gen("Department of Human Resources (DHR)"), "DHR");
        assert_eq!(gen("Technical Advisory Board (North)"), "Technical…");
    }

    #[test]
    fn words_are_shortened_one_at_a_time_largest_saving_first_and_only_as_far_as_needed() {
        // customer saves 3, service saves 3: the first of the tie goes first, and one is not enough.
        assert_eq!(gen("Customer Service"), "Cust. Svc.");
        // maintenance saves 5 and goes first; it alone fits.
        assert_eq!(gen("Maintenance Hub"), "Maint. Hub");
        // night would save only 2, so service goes first and the name already fits.
        assert_eq!(gen("Night Service"), "Night Svc.");
    }

    #[test]
    fn a_shortened_word_keeps_the_case_of_its_source() {
        assert_eq!(gen("MAINTENANCE"), "MAINT.");
        assert_eq!(gen("maintenance"), "maint.");
        assert_eq!(gen("Maintenance"), "Maint.");
        assert_eq!(gen("MAINTENANCE HUB"), "MAINT. HUB");
    }

    #[test]
    fn a_word_is_matched_whole_and_separators_survive() {
        assert_eq!(gen("Customer/Service"), "Cust./Svc.");
        assert_eq!(gen("Customers Desk"), "Customers…");
    }

    #[test]
    fn three_or_four_words_become_initials_skipping_connectors() {
        assert_eq!(gen("Department of Human Resources"), "DHR");
        assert_eq!(gen("Technical Advisory Board"), "TAB");
        assert_eq!(gen("Team of Top Rated Local"), "TTRL");
        assert_eq!(gen("Équipe Avancée Rapide"), "ÉAR");
        assert_eq!(gen("Alpha Beta Gamma Delta Epsilon"), "Alpha Bet…");
    }

    #[test]
    fn digits_and_qualifier_words_never_become_initials() {
        assert_eq!(gen("Alpha Beta Gamma 2"), "Alpha Bet…");
        assert_eq!(gen("Alpha Beta Gamma North"), "Alpha Bet…");
        assert_eq!(gen("Alpha Beta Night Gamma"), "Alpha Bet…");
    }

    #[test]
    fn a_name_nothing_shortens_is_cut_to_nine_graphemes_and_an_ellipsis() {
        assert_eq!(gen("01234567890"), "012345678…");
        assert_eq!(gen("Customer Service North"), "Customer …");
        assert_eq!(
            gen(&format!("{}x", "e\u{301}".repeat(10))),
            format!("{}…", "\u{e9}".repeat(9))
        );
    }

    #[test]
    fn a_name_is_normalised_before_it_is_judged() {
        // decomposed "ó" in "Administración" still finds its entry; the result is NFC.
        assert_eq!(gen("Administracio\u{301}n"), "Admón.");
    }

    #[test]
    fn a_collision_inside_the_attribute_moves_the_generated_form_to_its_next_step() {
        assert_eq!(
            generate_with(&FIXTURE, "Customer Service", &["Cust. Svc."], &[]),
            "Customer …"
        );
        assert_eq!(
            generate_with(&FIXTURE, "Technical Advisory Board", &["tab"], &[]),
            "Technical…"
        );
        assert_eq!(
            generate_with(&FIXTURE, "Kitchen", &["kitchen"], &[]),
            "Kitchen"
        );
    }

    #[test]
    fn only_the_lists_of_the_locale_language_apply() {
        assert_eq!(generate("es-MX", "Administración", &[], &[]), "Admón.");
        assert_eq!(generate("es", "Departamento Sur", &[], &[]), "Depto. Sur");
        assert_eq!(
            generate("es", "Dirección de Recursos Humanos", &[], &[]),
            "DRH"
        );
        assert_eq!(generate("en", "Administración", &[], &[]), "Administr…");
        assert_eq!(
            generate("en-GB", "Customer Service", &[], &[]),
            "Cust. Svc."
        );
        assert_eq!(generate("es", "Customer Service", &[], &[]), "Customer …");
        assert_eq!(generate("es", "Mantenimiento", &[], &[]), "Mant.");
        assert_eq!(generate("fr", "Maintenance", &[], &[]), "Maint.");
    }

    #[test]
    fn a_sourced_acronym_replaces_the_whole_name() {
        assert_eq!(gen_acr("Front of House"), "FOH");
        assert_eq!(gen_acr("Human Resources"), "HR");
    }

    #[test]
    fn a_sourced_acronym_combines_with_word_shortening_for_a_sub_phrase_inside_the_name() {
        // "Back of House" is the sourced acronym, combined with step 4 for "Maintenance".
        assert_eq!(gen_acr("Back of House Maintenance"), "BOH Maint.");
    }

    #[test]
    fn an_acronym_is_skipped_when_a_worksite_value_literally_is_it() {
        assert_eq!(gen_acr("Public Relations"), "PR");
        assert_eq!(gen_acr_in("Public Relations", &["PR"]), "Public Re…");
    }

    #[test]
    fn an_acronym_is_skipped_when_a_worksite_value_matches_another_expansion_of_it() {
        // "Payroll" is the acronym list's other expansion of "PR".
        assert_eq!(gen_acr_in("Public Relations", &["Payroll"]), "Public Re…");
    }

    #[test]
    fn an_acronym_is_skipped_when_a_worksite_value_states_it_explicitly_for_something_else() {
        // "Parking Reception" states "PR" for itself, validly (its initials).
        assert_eq!(
            gen_acr_in("Public Relations", &["Parking Reception (PR)"]),
            "Public Re…"
        );
    }

    #[test]
    fn a_skipped_acronym_falls_back_to_word_shortening() {
        assert_eq!(gen_acr_in("Human Resources", &["HR"]), "Human Res.");
    }

    #[test]
    fn validity_counts_graphemes_of_the_normalised_trimmed_form() {
        assert!(is_valid(" KS "));
        assert!(is_valid("0123456789"));
        assert!(!is_valid("01234567890"));
        assert!(!is_valid("   "));
        assert!(is_valid(&"e\u{301}".repeat(10)));
    }

    #[test]
    fn an_edited_form_is_kept_normalised_and_trimmed_while_anything_else_is_generated() {
        assert_eq!(
            resolve(
                "en",
                "Customer Service",
                Some(" Ke\u{301} "),
                Some(ORIGIN_EDITED),
                &[],
                &[]
            ),
            ("K\u{e9}".to_owned(), ORIGIN_EDITED.to_owned())
        );
        assert_eq!(
            resolve(
                "en",
                "Customer Service",
                Some("stale"),
                Some(ORIGIN_GENERATED),
                &[],
                &[]
            ),
            ("Cust. Svc.".to_owned(), ORIGIN_GENERATED.to_owned())
        );
    }

    #[test]
    fn apostrophes_and_hyphens_stay_inside_their_word() {
        assert_eq!(gen("Women's Health Group"), "WHG");
        assert_eq!(gen("Women\u{2019}s Health Group"), "WHG");
        assert_eq!(gen("Self-Help Group Leaders"), "SGL");
        assert_eq!(gen("Health & Safety Team"), "HST");
        assert_eq!(gen("Health and Safety Team"), "HAST");
    }

    #[test]
    fn a_hyphenated_name_still_has_its_words_shortened() {
        assert_eq!(gen("Customer-Service"), "Cust.-Svc.");
    }

    #[test]
    fn the_cut_keeps_the_ninth_grapheme_even_when_it_is_a_space() {
        // The spec rule is literal (9 graphemes, then the ellipsis), and the reviewed
        // Agitations header expectation pins "Rotating …": no trimming.
        assert_eq!(gen("Customer Service North"), "Customer …");
        assert_eq!(gen("Dispatch Crew Night Shift"), "Dispatch …");
    }

    #[test]
    fn a_qualifier_of_the_locale_language_blocks_initials() {
        assert_eq!(
            generate("es", "Dirección de Recursos Humanos", &[], &[]),
            "DRH"
        );
        assert_eq!(
            generate("es", "Dirección de Recursos Norte", &[], &[]),
            "Dirección…"
        );
        // English has no "norte" qualifier and no "de" connector: four words, initials.
        assert_eq!(
            generate("en", "Dirección de Recursos Norte", &[], &[]),
            "DDRN"
        );
    }

    #[test]
    fn connectors_do_not_count_toward_the_word_limit_but_a_fifth_word_does() {
        assert_eq!(gen("Department of the Human Resources"), "DHR");
        assert_eq!(gen("Department of the Human Resources Services"), "DHRS");
        assert_eq!(
            gen("Department of Human Resources Services Team"),
            "Departmen…"
        );
    }

    #[test]
    fn an_odd_locale_falls_back_to_the_language_it_names_or_english() {
        for (locale, word, form) in [
            ("es_MX", "Mantenimiento", "Mant."),
            ("ES", "Mantenimiento", "Mant."),
            ("es-419", "Mantenimiento", "Mant."),
            ("", "Maintenance", "Maint."),
            ("fr", "Maintenance", "Maint."),
            ("-", "Maintenance", "Maint."),
        ] {
            assert_eq!(generate(locale, word, &[], &[]), form, "{locale:?}");
        }
    }

    fn entry<'a>(name: &'a str, stored: Option<(&'a str, &'a str)>) -> Entry<'a> {
        Entry {
            name,
            form: None,
            origin: None,
            stored: stored.map(|(old, form)| (old, form, ORIGIN_GENERATED)),
        }
    }

    #[test]
    fn a_stored_generated_form_stays_while_its_name_is_unchanged() {
        // A stored form that the lists would no longer produce is not regenerated.
        let kept = resolve_attribute(
            "en",
            &[entry(
                "Customer Service",
                Some(("Customer Service", "Cust Serv")),
            )],
            &[],
            true,
        );
        assert_eq!(kept[0].0, "Cust Serv");
        let renamed = resolve_attribute(
            "en",
            &[entry(
                "Maintenance",
                Some(("Customer Service", "Cust Serv")),
            )],
            &[],
            true,
        );
        assert_eq!(renamed[0].0, "Maint.");
    }

    #[test]
    fn a_kept_form_gives_way_when_it_now_collides_and_new_values_do_not_move_old_ones() {
        let both = resolve_attribute(
            "en",
            &[
                entry("Kitchen", None),
                entry("Customer Service", Some(("Customer Service", "Cust Serv"))),
                entry("Customer Svc.", Some(("Customer Svc.", "Cust Serv"))),
            ],
            &[],
            true,
        );
        assert_eq!(both[1].0, "Cust Serv");
        assert_eq!(both[2].0, "Cust. Svc.");
    }

    #[test]
    fn a_stored_acronym_regenerates_only_once_a_worksite_value_makes_it_conflict() {
        let kept = resolve_attribute(
            "en",
            &[entry("Public Relations", Some(("Public Relations", "PR")))],
            &[],
            true,
        );
        assert_eq!(kept[0].0, "PR");
        let conflicting = resolve_attribute(
            "en",
            &[entry("Public Relations", Some(("Public Relations", "PR")))],
            &["Payroll"],
            true,
        );
        assert_ne!(conflicting[0].0, "PR");
    }

    /// An `Entry` carrying an edited form and origin, for the `lists_current` tests: an
    /// edited value is never regenerated, with or without a stored history.
    fn edited_entry<'a>(name: &'a str, form: &'a str) -> Entry<'a> {
        Entry {
            name,
            form: Some(form),
            origin: Some(ORIGIN_EDITED),
            stored: Some((name, "whatever the organizer replaced", ORIGIN_EDITED)),
        }
    }

    #[test]
    fn a_list_revision_change_regenerates_a_stored_generated_form_with_an_unchanged_name() {
        // "Cust Serv" is a stale stored form the current lists would not themselves
        // produce for "Customer Service" (ADR 0046 ticket 05: `lists_for("en")` now
        // shortens to "Cust. Svc."). With the lists current it is kept exactly as the
        // earlier `a_stored_generated_form_stays_while_its_name_is_unchanged` test
        // proves; once the bundled lists' revision has moved on, the same stale stored
        // form is no longer treated as unchanged and is regenerated.
        let stale = entry("Customer Service", Some(("Customer Service", "Cust Serv")));
        let current = resolve_attribute("en", &[stale], &[], true);
        assert_eq!(current[0].0, "Cust Serv", "unaffected while lists_current");

        let stale_again = entry("Customer Service", Some(("Customer Service", "Cust Serv")));
        let regenerated = resolve_attribute("en", &[stale_again], &[], false);
        assert_eq!(regenerated[0].0, "Cust. Svc.");
        assert_ne!(
            regenerated[0].0, "Cust Serv",
            "a list revision change must actually move the stored form, not just revalidate it"
        );
    }

    #[test]
    fn a_list_revision_change_never_touches_an_edited_form() {
        let edited = edited_entry("Customer Service", "Whatever I Want");
        let resolved = resolve_attribute("en", &[edited], &[], false);
        assert_eq!(
            resolved[0],
            ("Whatever I Want".to_owned(), ORIGIN_EDITED.to_owned())
        );
    }

    #[test]
    fn a_list_revision_change_regenerates_every_generated_value_of_an_attribute_at_once() {
        let resolved = resolve_attribute(
            "en",
            &[
                entry("Customer Service", Some(("Customer Service", "Cust Serv"))),
                edited_entry("Maintenance", "My Maint"),
            ],
            &[],
            false,
        );
        assert_eq!(resolved[0].0, "Cust. Svc.");
        assert_eq!(
            resolved[1],
            ("My Maint".to_owned(), ORIGIN_EDITED.to_owned())
        );
    }
}
