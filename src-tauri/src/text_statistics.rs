#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub words: usize,
    pub characters: usize,
}

pub fn count(text: &str) -> Counts {
    Counts {
        words: text.split_whitespace().count(),
        characters: text.chars().count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_empty_string() {
        assert_eq!(
            Counts {
                words: 0,
                characters: 0
            },
            count("")
        );
    }

    #[test]
    fn counts_whitespace_only() {
        assert_eq!(
            Counts {
                words: 0,
                characters: 5
            },
            count(" \n\t\r ")
        );
    }

    #[test]
    fn counts_normal_text() {
        assert_eq!(
            Counts {
                words: 4,
                characters: 19
            },
            count("One two\nthree four.")
        );
    }

    #[test]
    fn counts_unicode_characters_not_bytes() {
        assert_eq!(
            Counts {
                words: 2,
                characters: 7
            },
            count("Hi café")
        );
    }
}
