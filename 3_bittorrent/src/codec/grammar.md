## Lexical & Grammar Specification

The payload parsing engine conforms to the following Extended Backus-Naur Form (EBNF) definition of the Bencoding format (BEP 0003).

```ebnf
bencode    = string | integer | list | dictionary ;

integer    = "i" , [ "-" ] , number , "e" ;
number     = "0" | ( non_zero_digit , { digit } ) ;

string     = length , ":" , { byte } ;
length     = "0" | ( non_zero_digit , { digit } ) ;

list       = "l" , { bencode } , "e" ;
dictionary = "d" , { string , bencode } , "e" ;

non_zero_digit = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;
digit          = "0" | non_zero_digit ;
byte           = ? any 8-bit octet (0x00 - 0xFF) ? ;
```

### Semantic Constraints & Spec Compliance

While the EBNF above captures the structural syntax, full compliance with [BEP 0003](https://www.bittorrent.org/beps/bep_0003.html) enforces the following semantic invariants:

1. **Integer Representation Constraints**:
   * Negative zero (`i-0e`) is forbidden.
   * Leading zeros (e.g., `i03e`) are forbidden, except for the literal integer zero (`i0e`).
2. **Context-Sensitive String Parsing**:
   * The `{ byte }` sequence in a `string` rule is bounded dynamically by the preceding `length` value. The parser consumes exactly $N$ octets following the `:` delimiter.
3. **Dictionary Key Ordering**:
   * Keys within a `dictionary` must be valid `string` instances.
   * Keys must be ordered lexicographically by raw byte values (e.g., `3:cow` precedes `3:moo`). Duplicate keys are prohibited.

---

Grammar (EBNF): the structural syntax of Bencode.
Semantic constraints: rules that EBNF alone cannot express, such as:
- i-0e is invalid.
- Leading zeros are forbidden.
- A string consumes exactly length bytes.
- Dictionary keys must be unique and sorted lexicographically.
