-- Folio-SQL-Test-Fixture. In dieser Iteration: KEIN Highlight.

CREATE TABLE IF NOT EXISTS books (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    author      TEXT NOT NULL,
    year        INTEGER,
    available   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_books_author ON books (author);

INSERT INTO books (title, author, year, available) VALUES
    ('Programming Rust',             'Jim Blandy',   2021, TRUE),
    ('The Rust Programming Language','Steve Klabnik',2019, FALSE),
    ('Rust for Rustaceans',          'Jon Gjengset', 2021, TRUE);

-- Mehrzeilige
-- Kommentare
/* sowie ein
   Block-Kommentar */

SELECT b.id, b.title, b.author, b.year
  FROM books AS b
 WHERE b.available = TRUE
   AND b.year >= 2020
 ORDER BY b.year DESC, b.title ASC
 LIMIT 10;

UPDATE books
   SET available = FALSE
 WHERE id IN (1, 2, 3)
   AND title LIKE '%Rust%';

DELETE FROM books WHERE year < 2000;

-- Strings: 'mit ''doppelten'' Quotes'
-- Zahlen: 0, 42, -1, 3.14
-- Bool/Null: TRUE, FALSE, NULL
