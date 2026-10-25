//! Incremental UTF-8 decoding for byte streams that are chunked at arbitrary
//! boundaries (PTY reads, SSH channel packets).

/// Decodes byte chunks to text without corrupting multi-byte characters that
/// straddle a chunk boundary. Invalid bytes are replaced with U+FFFD (matching
/// `String::from_utf8_lossy`); an incomplete trailing sequence is held back
/// until the next chunk completes it.
///
/// Without this, a 32 KiB read boundary landing inside a CJK character turns
/// both halves into replacement characters that are permanently burned into
/// the terminal scrollback.
#[derive(Default)]
pub struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    text.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let prefix =
                            std::str::from_utf8(&self.pending[..valid_up_to]).unwrap_or_default();
                        text.push_str(prefix);
                    }
                    match error.error_len() {
                        // Genuinely invalid bytes: emit one replacement
                        // character and keep decoding after them.
                        Some(invalid_len) => {
                            text.push('\u{FFFD}');
                            self.pending.drain(..valid_up_to + invalid_len);
                        }
                        // Incomplete trailing sequence: keep it (at most 3
                        // bytes) for the next chunk.
                        None => {
                            self.pending.drain(..valid_up_to);
                            break;
                        }
                    }
                }
            }
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8StreamDecoder;

    fn feed_all(chunks: &[&[u8]]) -> String {
        let mut decoder = Utf8StreamDecoder::new();
        chunks.iter().map(|chunk| decoder.feed(chunk)).collect()
    }

    #[test]
    fn passes_ascii_through_unchanged() {
        assert_eq!(feed_all(&[b"hello ", b"world"]), "hello world");
    }

    #[test]
    fn reassembles_multibyte_characters_split_across_chunks() {
        // 中 (E4 B8 AD) and 😀 (F0 9F 98 80) split byte-by-byte.
        assert_eq!(
            feed_all(&[
                &[0xE4],
                &[0xB8],
                &[0xAD],
                &[0xF0],
                &[0x9F],
                &[0x98],
                &[0x80]
            ]),
            "中😀"
        );
        assert_eq!(feed_all(&[&[0xE4, 0xB8], &[0xAD]]), "中");
    }

    #[test]
    fn splits_long_cjk_stream_at_every_boundary() {
        let text = "中文输出测试".repeat(1000);
        let bytes = text.as_bytes();
        for chunk_size in [1, 2, 3, 7, 31, 1024] {
            let mut decoder = Utf8StreamDecoder::new();
            let mut decoded = String::new();
            for chunk in bytes.chunks(chunk_size) {
                decoded.push_str(&decoder.feed(chunk));
            }
            assert_eq!(decoded, text, "chunk size {chunk_size}");
        }
    }

    #[test]
    fn replaces_invalid_bytes_with_replacement_characters() {
        // 0x80 is never a valid start byte; each one becomes U+FFFD.
        assert_eq!(feed_all(&[&[0x61, 0x80, 0x62]]), "a\u{FFFD}b");
        // A truncated 3-byte sequence followed by ASCII: the incomplete
        // prefix becomes U+FFFD, the ASCII passes through.
        assert_eq!(feed_all(&[&[0xE4, 0xB8], b"x"]), "\u{FFFD}x");
    }

    #[test]
    fn holds_incomplete_tail_until_completed() {
        let mut decoder = Utf8StreamDecoder::new();
        assert_eq!(decoder.feed(&[0xE4, 0xB8]), "");
        assert_eq!(decoder.feed(&[0xAD]), "中");
        // The decoder never grows unbounded on pathological input.
        let replacement: String = std::iter::repeat_n('\u{FFFD}', 64).collect();
        let garbage: Vec<u8> = vec![0x80; 64];
        assert_eq!(decoder.feed(&garbage), replacement);
    }
}
