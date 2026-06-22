# wordfreq — top-N word frequencies
`wordfreq N` reads text from stdin and prints the N most frequent words, one per
line as `word count`. Words are maximal runs of lowercase letters and digits
after lowercasing the whole input; every other character is a separator. Ties
(equal count) break by ascending word order. Print fewer than N lines if there
are fewer distinct words.
