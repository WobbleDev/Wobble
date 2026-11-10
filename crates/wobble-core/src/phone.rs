//! The one Phone rule, shared by the strict field patch and the whole-record update:
//! digits only, a leading 1 dropped when 11 digits remain, laid out `(AAA) EEE-NNNN`.
//! It checks the count, not whether the area code is real.

/// The value's ASCII digits, once the digits are taken.
fn phone_digits(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect()
}

/// The stored shape of a clean number, or `None` when the value is not one. An empty
/// value is clean and stays empty; any other text may hold only digits and punctuation
/// and has to leave exactly 10 of them.
pub fn normalize_phone(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(String::new());
    }
    // The typed patch refuses letters outright, even beside ten usable digits: a
    // value like "call 555-010-0100" is free text, not a number to reformat.
    if trimmed.chars().any(char::is_alphabetic) {
        return None;
    }

    stored_phone(phone_digits(trimmed))
}

/// The CSV import's rule: every non-digit is stripped (letters included), a leading 1
/// is dropped when 11 digits remain, and exactly 10 digits are stored formatted. An
/// empty value is clean and stays empty; anything else that does not leave 10 digits
/// is `None`, so the import stores it blank.
pub fn clean_import_phone(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(String::new());
    }

    stored_phone(phone_digits(trimmed))
}

/// The whole-record update's rule: a clean number is stored formatted, and any other
/// value is stored trimmed as it came, so a Worker whose stored Phone predates the
/// format stays editable.
pub fn phone_for_whole_record_update(value: &str) -> String {
    normalize_phone(value).unwrap_or_else(|| value.trim().to_owned())
}

/// Drops a leading 1 when 11 digits remain, and lays exactly 10 digits out.
fn stored_phone(mut digits: String) -> Option<String> {
    if digits.len() == 11 && digits.starts_with('1') {
        digits.remove(0);
    }
    (digits.len() == 10).then(|| format_phone_digits(&digits))
}

/// `(AAA) EEE-NNNN` for exactly 10 digits.
fn format_phone_digits(digits: &str) -> String {
    format!("({}) {}-{}", &digits[..3], &digits[3..6], &digits[6..])
}
