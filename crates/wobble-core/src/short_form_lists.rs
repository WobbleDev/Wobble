//! The bundled lists a generated Short form draws on (ADR 0046), one set per language. Only
//! the lists of the request locale's language apply. The `words` and `acronyms` arrays come
//! from `short_form_lists_generated` (ticket 05): the versioned snapshot a developer-run
//! script under `scripts/short-form-lists/` writes from pinned, checksummed source inputs,
//! never from a network call the app itself makes. `connectors` and `qualifiers` are closed,
//! hand-authored function-word lists with no source to fetch, so they stay here.

pub use crate::short_form_lists_generated::REVISION;

/// The lists of one language. Words are lowercase; a shortening is stored lowercase and
/// takes the case of the word it replaces.
pub struct Lists {
    pub language: &'static str,
    /// Whole word -> its shortening.
    pub words: &'static [(&'static str, &'static str)],
    /// Words initials skip ("of", "de").
    pub connectors: &'static [&'static str],
    /// Words that carry a distinction initials would hide (North, Night, No).
    pub qualifiers: &'static [&'static str],
    /// A lowercase whole-word phrase -> the sourced acronym it stands for. Ambiguous
    /// acronyms keep every expansion (ADR 0046), so the worksite conflict check can find
    /// them.
    pub acronyms: &'static [(&'static str, &'static str)],
}

pub static ENGLISH: Lists = Lists {
    language: "en",
    words: crate::short_form_lists_generated::ENGLISH_WORDS,
    connectors: &["of", "the", "and", "for", "to", "in", "at", "on", "&"],
    qualifiers: &[
        "no",
        "not",
        "non",
        "without",
        "none",
        "unassigned",
        "north",
        "south",
        "east",
        "west",
        "northern",
        "southern",
        "eastern",
        "western",
        "day",
        "night",
        "overnight",
        "morning",
        "afternoon",
        "evening",
        "temporary",
        "permanent",
        "assistant",
    ],
    acronyms: crate::short_form_lists_generated::ENGLISH_ACRONYMS,
};

pub static SPANISH: Lists = Lists {
    language: "es",
    words: crate::short_form_lists_generated::SPANISH_WORDS,
    connectors: &[
        "de", "del", "la", "las", "el", "los", "y", "e", "para", "en", "&",
    ],
    qualifiers: &[
        "sin",
        "nunca",
        "norte",
        "sur",
        "este",
        "oeste",
        "día",
        "noche",
        "temporal",
        "permanente",
        "asistente",
    ],
    acronyms: crate::short_form_lists_generated::SPANISH_ACRONYMS,
};

/// The lists for a locale tag such as "es", "es-MX" or "en-GB": its language's lists, or
/// English for a language the app has none for.
pub fn lists_for(locale: &str) -> &'static Lists {
    let language = locale.split(['-', '_']).next().unwrap_or("").to_lowercase();
    match language.as_str() {
        "es" => &SPANISH,
        _ => &ENGLISH,
    }
}
