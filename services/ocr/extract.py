"""Turn OCR lines into WeTa Snap card fields (AI-02, AI-03, AI-05, AI-08).

Pure standard library on purpose: the tests run without Surya, Tesseract,
Pillow or numpy installed. Nothing here touches the network or the disk.

The heuristics use the line boxes, not just the text: the largest line near
the top of a card is almost always the person, and the line carrying a legal
suffix (GmbH, SAS, S.r.l., B.V., Ltd, Lda, AB, SL) is almost always the company.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field as _dc_field
from typing import Iterable, Literal, Optional, Sequence

FieldType = Literal["text", "email", "phone", "link", "choice", "longtext"]

# Below this, the app shows the `reason` note to the person reviewing (AI-03).
UNSURE_BELOW = 0.8


# --------------------------------------------------------------------------
# Inputs
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Line:
    """One OCR line. bbox is (x0, y0, x1, y1) in pixels, y growing downwards."""

    text: str
    bbox: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    confidence: float = 0.5

    @property
    def height(self) -> float:
        return max(0.0, self.bbox[3] - self.bbox[1])

    @property
    def top(self) -> float:
        return self.bbox[1]

    @property
    def left(self) -> float:
        return self.bbox[0]


@dataclass(frozen=True)
class FieldSpec:
    """One field the company asked for (mirrors FieldDefinition in types.ts)."""

    key: str
    label: str = ""
    type: FieldType = "text"
    options: tuple[str, ...] = ()
    ai_hint: str = ""
    required: bool = False


@dataclass
class Extracted:
    """One answer. `reason` is set whenever confidence < UNSURE_BELOW (AI-03)."""

    value: str
    confidence: float
    reason: Optional[str] = None


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))


def _norm(s: str) -> str:
    """Lowercase, unaccented, punctuation-free — for comparing words."""
    return re.sub(r"[^a-z0-9]+", " ", _strip_accents(s).lower()).strip()


def _squash(s: str) -> str:
    """Only the letters and digits, lowercased — for comparing a name to a domain."""
    return re.sub(r"[^a-z0-9]+", "", _strip_accents(s).lower())


def _blend(heuristic: float, ocr: float) -> float:
    """Field confidence = how sure the rule is, dragged down by weak OCR."""
    ocr = min(1.0, max(0.0, ocr))
    return round(min(0.99, max(0.05, heuristic * (0.75 + 0.25 * ocr))), 2)


def _clean(s: str) -> str:
    """Tidy the edges — but a trailing dot belongs to "B.V." and "S.r.l."."""
    s = re.sub(r"\s+", " ", s).strip()
    s = s.strip(" \t,;:|·•-–—")
    while s.endswith(".") and not re.search(r"(?:^|[\s.])[A-Za-z]\.$", s):
        s = s[:-1].rstrip(" \t,;:|·•-–—")
    return s.lstrip(".")


# --------------------------------------------------------------------------
# Patterns
# --------------------------------------------------------------------------

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")

URL_RE = re.compile(
    r"\b(?:https?://)?(?:www\.)?"
    r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+"
    r"(?:com|net|org|eu|de|fr|it|es|nl|pt|be|at|ch|uk|ie|se|dk|no|fi|pl|cz|lu|info|biz|tech|io|co)"
    r"(?:\.[a-z]{2})?(?:/\S*)?\b",
    re.IGNORECASE,
)

PHONE_RE = re.compile(r"(?:\+|00)?\s*\(?\d[\d\s().\-/]{6,}\d")

LEGAL_SUFFIX_RE = re.compile(
    r"(?<![A-Za-z0-9])("
    r"gmbh(?:\s*&\s*co\.?\s*kg)?|mbh|ag|kg|ohg|ug|e\.?\s?k\.?|"          # DE / AT / CH
    r"s\.?a\.?s\.?|s\.?a\.?r\.?l\.?|sarl|sas|eurl|s\.?c\.?a\.?|"        # FR
    r"s\.?r\.?l\.?|s\.?p\.?a\.?|srls|"                                   # IT
    r"s\.?l\.?u?\.?|s\.?a\.?u?\.?|"                                      # ES
    r"b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|"                                   # NL / BE
    r"lda\.?|unipessoal|"                                                # PT
    r"ltd\.?|limited|llp|plc|llc|inc\.?|corp\.?|co\.?|"                  # EN
    r"ab|as|a\/s|aps|oy|oyj|sp\.?\s?z\.?\s?o\.?o\.?|s\.?r\.?o\.?"        # Nordics / PL / CZ
    r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)

JOB_TITLE_RE = re.compile(
    r"(?i)\b("
    r"ceo|cto|cfo|coo|cmo|cio|chief|president|vice\s+president|vp|"
    r"managing\s+director|director|directrice|directeur|direttore|diretor|director[ae]|"
    r"manager|management|head\s+of|lead|leader|owner|founder|co-?founder|partner|"
    r"geschaftsfuhrer|geschäftsführer|geschaeftsfuehrer|inhaber|leiter(?:in)?|prokurist(?:in)?|vertrieb(?:sleiter)?|"
    r"responsable|responsabile|responsavel|respons[áa]vel|gerente|jefe|encargado|"
    r"zaakvoerder|bestuurder|inkoper|verkoopleider|directeur|"
    r"sales|vendas|ventas|vendite|vente[s]?|verkauf|verkoop|marketing|"
    r"purchasing|procurement|einkauf|acquisti|achats|compras|"
    r"engineer|ingenieur|ing[ée]nieur|ingegnere|ingeniero|consultant|berater(?:in)?|"
    r"specialist|spezialist|especialista|officer|account\s+executive|representative"
    r")\b"
)

# Words that mean "this line is a phone number", per language.
PHONE_LABEL_RE = re.compile(
    r"(?i)(?<![a-z])("
    r"t[ée]l[ée]phone|telephone|telefon|tel[eé]fono|telefono|telefoon|telef|t[ée]l|tel|phone|fon|"
    r"mob|mobil|mobile|m[oó]vil|movil|cellulare|telem[oó]vel|cell|handy|gsm|portable|port|"
    r"fax|telefax|direct|durchwahl|office|b[uü]ro|centralino|std"
    r")\.?(?![a-z])"
)
MOBILE_LABEL_RE = re.compile(
    r"(?i)(?<![a-z])("
    r"telem[oó]vel|cellulare|portable|mobile|mobil|m[oó]vil|movil|handy|gsm|"
    r"mob|cell|cel|port"
    r")\.?(?![a-z])"
)
FAX_LABEL_RE = re.compile(r"(?i)(?<![a-z])(telefax|fax)\.?(?![a-z])")
# A bare "M:" / "T:" / "F:" / "T " prefix, common on minimal cards.
SHORT_LABEL_RE = re.compile(r"(?i)^\s*([tmfp])\s*(?:[:.]\s*|\s+)(?=[+(\d])")

STREET_RE = re.compile(
    r"(?i)("
    r"stra[sß]e|strasse|str\.|platz|weg|gasse|allee|ring|ufer|"          # DE
    r"rue|avenue|av\.|boulevard|bd\.|impasse|chemin|place|quai|route|"   # FR
    r"via|viale|piazza|corso|vicolo|largo|"                              # IT
    r"calle|c\/|avenida|plaza|paseo|carrer|camino|"                      # ES
    r"straat|laan|plein|kade|dijk|singel|weg|"                           # NL
    r"rua|avenida|travessa|largo|praca|pra[çc]a|"                        # PT
    r"street|st\.|road|rd\.|lane|drive|park|square|suite|floor|unit"     # EN
    r")(?![a-z])"
)

# postcode + town, per country shape
POSTCODE_RES: dict[str, re.Pattern[str]] = {
    "NL": re.compile(r"\b\d{4}\s?[A-Z]{2}\b"),
    "PT": re.compile(r"\b\d{4}-\d{3}\b"),
    "GB": re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b"),
    "SE": re.compile(r"\b\d{3}\s?\d{2}\b"),
    "_5": re.compile(r"\b\d{5}\b"),  # DE / FR / ES / IT all use five digits
    "_4": re.compile(r"\b\d{4}\b"),  # AT / BE / CH / DK
}

TLD_COUNTRY: dict[str, tuple[str, str]] = {
    "de": ("+49", "Germany"),
    "at": ("+43", "Austria"),
    "ch": ("+41", "Switzerland"),
    "fr": ("+33", "France"),
    "it": ("+39", "Italy"),
    "es": ("+34", "Spain"),
    "nl": ("+31", "Netherlands"),
    "pt": ("+351", "Portugal"),
    "be": ("+32", "Belgium"),
    "uk": ("+44", "United Kingdom"),
    "ie": ("+353", "Ireland"),
    "se": ("+46", "Sweden"),
    "dk": ("+45", "Denmark"),
    "no": ("+47", "Norway"),
    "fi": ("+358", "Finland"),
    "pl": ("+48", "Poland"),
    "cz": ("+420", "Czechia"),
}

LANG_COUNTRY: dict[str, tuple[str, str]] = {
    "de": ("+49", "Germany"),
    "fr": ("+33", "France"),
    "it": ("+39", "Italy"),
    "es": ("+34", "Spain"),
    "nl": ("+31", "Netherlands"),
    "pt": ("+351", "Portugal"),
    # "en" is deliberately absent: English cards come from anywhere.
}

# Longest calling codes first so +351 wins over +35.
CC_COUNTRY: dict[str, str] = {cc: name for cc, name in TLD_COUNTRY.values()}

# Country written on the card, in any of the seven languages we support.
COUNTRY_WORDS: dict[str, str] = {}
for _canonical, _names in {
    "Germany": ["germany", "deutschland", "allemagne", "alemania", "germania", "duitsland", "alemanha"],
    "Austria": ["austria", "osterreich", "autriche", "oostenrijk"],
    "Switzerland": ["switzerland", "schweiz", "suisse", "svizzera", "suiza", "zwitserland", "suica"],
    "France": ["france", "frankreich", "francia", "frankrijk", "franca"],
    "Italy": ["italy", "italia", "italien", "italie", "italie", "italien"],
    "Spain": ["spain", "espana", "espagne", "spanien", "spagna", "spanje", "espanha"],
    "Netherlands": ["netherlands", "nederland", "pays bas", "niederlande", "paesi bassi", "paises bajos", "holland"],
    "Portugal": ["portugal", "portugalia"],
    "Belgium": ["belgium", "belgie", "belgique", "belgien", "belgio", "belgica"],
    "United Kingdom": ["united kingdom", "great britain", "england", "grossbritannien", "royaume uni", "reino unido"],
    "Sweden": ["sweden", "sverige", "schweden", "suede"],
}.items():
    for _n in _names:
        COUNTRY_WORDS[_n] = _canonical

# Surname particles: "Sanne de Vries" splits as Sanne / de Vries, not Sanne de / Vries.
PARTICLES = {
    "de", "del", "della", "der", "den", "di", "da", "das", "dos", "du", "van",
    "von", "ter", "ten", "le", "la", "el", "al", "bin", "mc", "mac", "op", "'t",
}

HONORIFICS = {
    "dr", "prof", "ing", "dipl", "mr", "mrs", "ms", "mag", "dipl ing", "msc",
    "bsc", "mba", "herr", "frau", "monsieur", "madame", "sr", "sra", "drs", "ir",
}


# --------------------------------------------------------------------------
# Phone handling (AI-08)
# --------------------------------------------------------------------------


def normalise_phone(raw: str, calling_code: Optional[str] = None) -> tuple[str, bool]:
    """Best effort E.164. Returns (value, is_international).

    Keeps the leading "+" whenever a country can be worked out; otherwise hands
    back a tidied local number so nothing is silently thrown away.
    """
    s = raw.strip()
    # A trunk "0" in brackets is dropped when dialling internationally: +49 (0)89 -> +4989
    s = re.sub(r"\(\s*0\s*\)", "", s)
    plus = s.lstrip().startswith("+")
    digits = re.sub(r"\D", "", s)
    if not digits:
        return "", False

    if digits.startswith("00"):
        return "+" + digits[2:], True
    if plus:
        return "+" + digits, True
    if calling_code:
        local = digits.lstrip("0")
        cc = calling_code.lstrip("+")
        if digits.startswith(cc) and len(digits) > len(cc) + 5:
            return "+" + digits, True
        return "+" + cc + local, True
    return _clean(re.sub(r"[.\-/]", " ", s)), False


def _country_from_calling_code(value: str) -> Optional[str]:
    if not value.startswith("+"):
        return None
    for cc in sorted(CC_COUNTRY, key=len, reverse=True):
        if value.startswith(cc):
            return CC_COUNTRY[cc]
    return None


def _looks_mobile(e164: str) -> bool:
    """National mobile ranges for the countries WeTa Snap sells into."""
    for cc, pattern in (
        ("+49", r"^1[5-7]"),       # DE
        ("+43", r"^6"),            # AT
        ("+41", r"^7[5-9]"),       # CH
        ("+33", r"^[67]"),         # FR
        ("+39", r"^3"),            # IT
        ("+34", r"^[67]"),         # ES
        ("+31", r"^6"),            # NL
        ("+351", r"^9"),           # PT
        ("+32", r"^4"),            # BE
        ("+44", r"^7"),            # UK
    ):
        if e164.startswith(cc):
            return bool(re.match(pattern, e164[len(cc):]))
    return False


@dataclass
class PhoneHit:
    raw: str
    line_index: int
    kind: Literal["mobile", "fax", "phone", "bare"]
    ocr_confidence: float


def find_phones(lines: Sequence[Line]) -> list[PhoneHit]:
    """Every phone-looking run on the card, labelled by the words around it."""
    hits: list[PhoneHit] = []
    for i, line in enumerate(lines):
        text = line.text
        if EMAIL_RE.search(text) or URL_RE.search(text):
            continue
        for m in PHONE_RE.finditer(text):
            raw = m.group(0)
            if len(re.sub(r"\D", "", raw)) < 7:
                continue
            before = text[: m.start()]
            short = SHORT_LABEL_RE.match(text)
            if FAX_LABEL_RE.search(before) or (short and short.group(1).lower() == "f"):
                kind: Literal["mobile", "fax", "phone", "bare"] = "fax"
            elif MOBILE_LABEL_RE.search(before) or (short and short.group(1).lower() == "m"):
                kind = "mobile"
            elif PHONE_LABEL_RE.search(before) or (short and short.group(1).lower() in {"t", "p"}):
                kind = "phone"
            else:
                kind = "bare"
            hits.append(PhoneHit(_clean(raw), i, kind, line.confidence))
    return hits


# --------------------------------------------------------------------------
# Single-value finders
# --------------------------------------------------------------------------


# Public mailbox providers: somebody@gmail.com says nothing about their company, so the
# website guess (and only the website guess) must ignore these. Global + regional free
# mail, kept in sync with FREE_MAIL_DOMAINS in apps/web/src/lib/offlineReader.ts.
FREE_MAIL_DOMAINS: frozenset[str] = frozenset({
    # Global giants.
    "gmail.com", "googlemail.com",
    "yahoo.com", "ymail.com", "rocketmail.com",
    "outlook.com", "hotmail.com", "live.com", "msn.com",
    "icloud.com", "me.com", "mac.com",
    "aol.com", "aim.com",
    "proton.me", "protonmail.com", "pm.me",
    "tutanota.com", "tutanota.de",
    "zoho.com", "zohomail.com",
    "mail.com", "email.com", "inbox.com", "usa.com", "post.com",
    "fastmail.com", "fastmail.fm",
    "hushmail.com",
    # Regional Yahoo / Microsoft variants.
    "yahoo.fr", "yahoo.de", "yahoo.es", "yahoo.it", "yahoo.co.uk", "yahoo.ca",
    "yahoo.com.au", "yahoo.co.in", "yahoo.in", "yahoo.com.br", "yahoo.com.mx",
    "yahoo.co.jp", "yahoo.se",
    "hotmail.fr", "hotmail.de", "hotmail.es", "hotmail.it", "hotmail.co.uk",
    "hotmail.ca", "hotmail.com.au", "hotmail.com.br",
    "live.fr", "live.de", "live.co.uk", "live.ca", "live.com.au", "live.nl",
    "outlook.fr", "outlook.de", "outlook.es",
    "aol.fr", "aol.de", "aol.co.uk",
    # German free mail.
    "web.de", "gmx.de", "gmx.net", "gmx.com", "gmx.at", "gmx.ch",
    "t-online.de", "freenet.de", "arcor.de", "1und1.de", "posteo.de", "mailbox.org",
    # French free mail.
    "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "laposte.net", "neuf.fr",
    # Italian free mail.
    "libero.it", "virgilio.it", "tiscali.it", "alice.it", "tim.it", "email.it",
    # Spanish / Portuguese free mail.
    "terra.es", "telefonica.net", "latinmail.com", "mixmail.com", "sapo.pt",
    # Dutch / Belgian free mail.
    "planet.nl", "hetnet.nl", "home.nl", "upcmail.nl", "ziggo.nl", "kpnmail.nl",
    "skynet.be", "telenet.be",
    # British / Irish free mail.
    "btinternet.com", "sky.com", "virgin.net", "virginmedia.com", "ntlworld.com",
    "blueyonder.co.uk", "talk21.com", "eircom.net",
    # Nordic free mail.
    "spray.se", "telia.com", "luukku.com", "mail.dk", "online.no",
    # Polish / Czech free mail.
    "wp.pl", "o2.pl", "interia.pl", "onet.pl", "op.pl", "gazeta.pl",
    "seznam.cz", "email.cz", "centrum.cz",
    # North American ISP mail.
    "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net",
    "charter.net", "cox.net", "earthlink.net", "juno.com",
    "rogers.com", "shaw.ca", "telus.net", "bell.net", "sympatico.ca", "videotron.ca",
    # Australia / New Zealand ISP mail.
    "bigpond.com", "bigpond.net.au", "optusnet.com.au", "iinet.net.au",
    "xtra.co.nz",
    # Russian / CIS free mail.
    "yandex.ru", "yandex.com", "ya.ru", "mail.ru", "inbox.ru", "list.ru", "bk.ru",
    "rambler.ru",
    # Asian free mail.
    "qq.com", "163.com", "126.com", "sina.com", "sohu.com", "yeah.net", "139.com",
    "foxmail.com", "naver.com", "daum.net", "hanmail.net", "nate.com",
    "rediffmail.com", "docomo.ne.jp", "ezweb.ne.jp", "nifty.com",
    # Latin American free mail.
    "uol.com.br", "bol.com.br", "terra.com.br", "ig.com.br", "globo.com",
    # African / Middle Eastern free mail.
    "webmail.co.za", "mweb.co.za", "walla.co.il", "walla.com", "maktoob.com",
    "mynet.com", "tut.by",
})


def is_free_mail_domain(domain: str) -> bool:
    """True for gmail.com and friends — never a company website."""
    return domain.strip().lower().rstrip(".") in FREE_MAIL_DOMAINS


_SECOND_LEVEL = frozenset({"co", "com", "org", "net", "edu", "gov", "ac", "ne", "or", "go"})


def domain_base_of(domain: str) -> str:
    """The company behind an email domain ("enrichspaces.co.in" -> "enrichspaces")."""
    labels = [p for p in domain.strip().lower().rstrip(".").split(".") if p]
    if len(labels) < 2:
        return ""
    tld = labels[-1]
    rest = labels[:-2] if len(labels) > 2 and labels[-2] in _SECOND_LEVEL and len(tld) == 2 else labels[:-1]
    base = re.sub(r"[^a-z0-9]+", "", rest[-1] if rest else "")
    return base if len(base) >= 2 else ""


def _bigram_sim(a: str, b: str) -> float:
    """Dice similarity over character bigrams — one OCR slip still matches."""
    if a == b:
        return 1.0
    if len(a) < 2 or len(b) < 2:
        return 0.0
    left = [a[i:i + 2] for i in range(len(a) - 1)]
    right = [b[i:i + 2] for i in range(len(b) - 1)]
    total = len(left) + len(right)
    hit = 0
    for p in left:
        if p in right:
            right.remove(p)
            hit += 1
    return 2 * hit / total if total else 0.0


def _domain_score(text: str, base: str) -> float:
    """How much a card line agrees with the email domain (0–1)."""
    if not base or len(base) < 2:
        return 0.0
    sq = _squash(text)
    if not sq or len(sq) < 3:
        return 0.0
    if sq == base:
        return 1.0
    if len(sq) >= 4 and len(base) >= 4 and (sq in base or base in sq):
        return 0.85
    for w in re.split(r"[^a-z0-9]+", text.lower()):
        if len(w) >= 4 and (w == base or base in w or w in base):
            return 0.8
    sim = _bigram_sim(sq, base)
    return sim if sim >= 0.55 else 0.0


def _looks_like_person(text: str, local: str) -> bool:
    """A name-shaped line matching the email local part belongs to the person."""
    words = _clean(text).split()
    if not (2 <= len(words) <= 4):
        return False
    if not all(re.fullmatch(r"[A-Za-z][A-Za-z'’.\-]*", w) for w in words):
        return False
    local_sq = _squash(local)
    if not local_sq:
        return False
    return any(len(_squash(w)) >= 3 and _squash(w) in local_sq for w in words)


def find_email(lines: Sequence[Line]) -> Optional[tuple[str, float, int]]:
    """(email, ocr confidence, line index). Repairs the spaces OCR leaves around @."""
    for i, line in enumerate(lines):
        repaired = re.sub(r"\s*@\s*", "@", line.text)
        repaired = re.sub(r"(?i)\s*[\[(]\s*at\s*[\])]\s*", "@", repaired)
        m = EMAIL_RE.search(repaired)
        if m:
            return m.group(0).lower().strip(".,;:"), line.confidence, i
    return None


def find_website(lines: Sequence[Line], email: Optional[str] = None) -> Optional[tuple[str, float, int]]:
    for i, line in enumerate(lines):
        if EMAIL_RE.search(re.sub(r"\s*@\s*", "@", line.text)):
            continue
        m = URL_RE.search(line.text)
        if m:
            raw = m.group(0).rstrip(".,;:")
            url = raw if raw.lower().startswith("http") else "https://" + raw
            return url, line.confidence, i
    if email and "@" in email:
        host = email.split("@", 1)[1].strip().lower()
        # A public mailbox (gmail, yahoo, proton, …) is not a company website.
        if host and not is_free_mail_domain(host):
            return "https://" + host, 0.5, -1
    return None


def find_company(
    lines: Sequence[Line],
    email: Optional[str] = None,
    website: Optional[str] = None,
    skip: Iterable[int] = (),
) -> Optional[tuple[str, float, int, str]]:
    """(value, certainty 0..1, line index, why). Legal suffix first, domain second."""
    skip = set(skip)

    for i, line in enumerate(lines):
        if i in skip or EMAIL_RE.search(line.text) or URL_RE.search(line.text):
            continue
        if LEGAL_SUFFIX_RE.search(line.text) and len(_norm(line.text)) > 3:
            return _clean(line.text), 0.93, i, "legal-suffix"

    # The domain usually is the company: mueller-technik.de -> "Müller Technik".
    # A printed website outranks the email (0.9 beats 0.85) — it is harder evidence.
    web_host = ""
    if website:
        web_host = re.sub(r"^https?://(www\.)?", "", website, flags=re.IGNORECASE).split("/")[0]
    mail_host = email.split("@", 1)[1].strip().lower() if email and "@" in email else ""
    base, from_site = "", False
    if web_host and not is_free_mail_domain(web_host):
        base, from_site = domain_base_of(web_host), True
    if not base and mail_host and not is_free_mail_domain(mail_host):
        base, from_site = domain_base_of(mail_host), False
    if base:
        hit_conf = 0.9 if from_site else 0.85
        fuzzy_conf = 0.85 if from_site else 0.8
        why = "site-domain-match" if from_site else "domain-match"
        for i, line in enumerate(lines):
            if i in skip or EMAIL_RE.search(line.text) or URL_RE.search(line.text):
                continue
            squashed = _squash(line.text)
            if squashed == base or (
                len(squashed) >= 4 and len(base) >= 4 and (squashed in base or base in squashed)
            ):
                return _clean(line.text), hit_conf, i, why
        for i, line in enumerate(lines):
            if i in skip or EMAIL_RE.search(line.text) or URL_RE.search(line.text):
                continue
            if _bigram_sim(_squash(line.text), base) >= 0.55:
                return _clean(line.text), fuzzy_conf, i, why

    # Fall back to the biggest line that is not the person.
    local = email.split("@", 1)[0] if email and "@" in email else ""
    ranked = _by_prominence(lines, skip)
    for i, line in ranked:
        if _is_contact_line(line.text) or JOB_TITLE_RE.search(line.text):
            continue
        if _looks_like_person(line.text, local):
            continue
        return _clean(line.text), 0.5, i, "largest-remaining"
    return None


def _is_contact_line(text: str) -> bool:
    repaired = re.sub(r"\s*@\s*", "@", text)
    return bool(
        EMAIL_RE.search(repaired)
        or URL_RE.search(text)
        or PHONE_RE.search(text)
        or PHONE_LABEL_RE.search(text)
    )


def _by_prominence(lines: Sequence[Line], skip: Iterable[int] = ()) -> list[tuple[int, Line]]:
    """Lines sorted by (font size, nearness to the top) — the card's own hierarchy."""
    skip = set(skip)
    usable = [(i, l) for i, l in enumerate(lines) if i not in skip and len(_norm(l.text)) > 1]
    if not usable:
        return []
    page_bottom = max((l.bbox[3] for _, l in usable), default=1.0) or 1.0
    heights = sorted(l.height for _, l in usable)
    median = heights[len(heights) // 2] or 1.0

    def score(item: tuple[int, Line]) -> float:
        i, l = item
        size = (l.height / median) if median else 1.0
        near_top = 1.0 - min(1.0, (l.top / page_bottom) if page_bottom else 0.0)
        return size * 2.0 + near_top
    return sorted(usable, key=score, reverse=True)


def find_name(
    lines: Sequence[Line],
    email: Optional[str] = None,
    skip: Iterable[int] = (),
    website: Optional[str] = None,
) -> Optional[tuple[str, float, int, str]]:
    """(full name, certainty, line index, why).

    Largest line near the top wins, and the email local part is the tie-breaker:
    anna.schmidt@… next to "Anna Schmidt" is as certain as this gets. A line that
    IS the web or email domain is the company, never the person.
    """
    skip = set(skip)
    local = _squash(email.split("@", 1)[0]) if email and "@" in email else ""
    web_host = (
        re.sub(r"^https?://(www\.)?", "", website, flags=re.IGNORECASE).split("/")[0]
        if website else ""
    )
    mail_host = email.split("@", 1)[1].strip().lower() if email and "@" in email else ""
    base = ""
    if web_host and not is_free_mail_domain(web_host):
        base = domain_base_of(web_host)
    if not base and mail_host and not is_free_mail_domain(mail_host):
        base = domain_base_of(mail_host)

    candidates: list[tuple[int, Line]] = []
    for i, line in _by_prominence(lines, skip):
        text = line.text
        if _is_contact_line(text) or LEGAL_SUFFIX_RE.search(text):
            continue
        if base and _domain_score(text, base) >= 0.75:
            continue
        if re.search(r"\d", text) or JOB_TITLE_RE.search(text) or STREET_RE.search(text):
            continue
        words = [w for w in _clean(text).split() if _norm(w) not in HONORIFICS]
        if not (2 <= len(words) <= 4):
            continue
        candidates.append((i, line))

    if not candidates:
        return None

    if local:
        best: Optional[tuple[int, int, Line]] = None
        for i, line in candidates:
            words = [w for w in _clean(line.text).split() if _norm(w.rstrip(".")) not in HONORIFICS]
            squashed = [_squash(w) for w in words]
            matches = sum(1 for p in squashed if len(p) >= 3 and p in local)
            if matches and (best is None or matches > best[0]):
                best = (matches, i, line)
        if best is not None:
            matches, i, line = best
            return _clean(line.text), 0.95 if matches >= 2 else 0.88, i, "matches-email"

    i, line = candidates[0]
    return _clean(line.text), 0.72, i, "largest-near-top"


def split_name(full: str) -> tuple[str, str]:
    """"Sanne de Vries" -> ("Sanne", "de Vries"); "João Pereira" -> ("João", "Pereira")."""
    words = [w for w in _clean(full).split() if _norm(w.rstrip(".")) not in HONORIFICS]
    if not words:
        return "", ""
    if len(words) == 1:
        return "", words[0]
    cut = len(words) - 1
    for idx in range(len(words) - 2, 0, -1):
        if _norm(words[idx]) in PARTICLES:
            cut = idx
        else:
            break
    return " ".join(words[:cut]), " ".join(words[cut:])


def find_job_title(lines: Sequence[Line], skip: Iterable[int] = ()) -> Optional[tuple[str, float, int]]:
    skip = set(skip)
    for i, line in enumerate(lines):
        if i in skip or _is_contact_line(line.text) or LEGAL_SUFFIX_RE.search(line.text):
            continue
        if JOB_TITLE_RE.search(line.text):
            return _clean(line.text), 0.85, i
    return None


def find_address(lines: Sequence[Line], skip: Iterable[int] = ()) -> Optional[tuple[str, float, list[int]]]:
    """Street line plus the postcode/town line under it, joined with a comma."""
    skip = set(skip)
    street_idx: Optional[int] = None
    for i, line in enumerate(lines):
        if i in skip or _is_contact_line(line.text):
            continue
        if STREET_RE.search(line.text) and re.search(r"\d", line.text):
            street_idx = i
            break

    postcode_idx: Optional[int] = None
    for i, line in enumerate(lines):
        if i in skip or _is_contact_line(line.text) or i == street_idx:
            continue
        if any(p.search(line.text) for p in POSTCODE_RES.values()):
            postcode_idx = i
            break

    picked = [i for i in (street_idx, postcode_idx) if i is not None]
    if not picked:
        return None
    picked.sort()
    value = ", ".join(_clean(lines[i].text) for i in picked)
    certainty = 0.85 if len(picked) == 2 else 0.6
    return value, certainty, picked


def find_country(
    lines: Sequence[Line],
    phone_e164: Optional[str] = None,
    website: Optional[str] = None,
    email: Optional[str] = None,
    language: Optional[str] = None,
) -> Optional[tuple[str, float, str]]:
    """(country, certainty, why). Written on the card beats a guess from the domain."""
    for line in lines:
        n = _norm(line.text)
        for word, canonical in COUNTRY_WORDS.items():
            if re.search(rf"(?<![a-z]){re.escape(word)}(?![a-z])", n):
                return canonical, 0.92, "on-the-card"

    if phone_e164:
        c = _country_from_calling_code(phone_e164)
        if c:
            return c, 0.85, "phone-prefix"

    host = ""
    if website:
        host = re.sub(r"^https?://(www\.)?", "", website, flags=re.IGNORECASE).split("/")[0]
    elif email and "@" in email:
        host = email.split("@", 1)[1]
    if host:
        tld = host.rsplit(".", 1)[-1].lower()
        if tld in TLD_COUNTRY:
            return TLD_COUNTRY[tld][1], 0.75, "web-address"

    if language and language in LANG_COUNTRY:
        return LANG_COUNTRY[language][1], 0.5, "language"
    return None


def infer_calling_code(
    lines: Sequence[Line],
    website: Optional[str] = None,
    email: Optional[str] = None,
    language: Optional[str] = None,
) -> tuple[Optional[str], str]:
    """(+49, "web-address") — how to make a local number international (AI-08)."""
    host = ""
    if website:
        host = re.sub(r"^https?://(www\.)?", "", website, flags=re.IGNORECASE).split("/")[0]
    elif email and "@" in email:
        host = email.split("@", 1)[1]
    if host:
        tld = host.rsplit(".", 1)[-1].lower()
        if tld in TLD_COUNTRY:
            return TLD_COUNTRY[tld][0], "web-address"

    for line in lines:
        n = _norm(line.text)
        for word, canonical in COUNTRY_WORDS.items():
            if re.search(rf"(?<![a-z]){re.escape(word)}(?![a-z])", n):
                for cc, name in CC_COUNTRY.items():
                    if name == canonical:
                        return cc, "on-the-card"
    if language and language in LANG_COUNTRY:
        return LANG_COUNTRY[language][0], "language"
    return None, "unknown"


# --------------------------------------------------------------------------
# QR codes — a vCard beats every heuristic on this page
# --------------------------------------------------------------------------


def parse_vcard(payload: str) -> dict[str, str]:
    """The handful of vCard properties a business card actually carries."""
    out: dict[str, str] = {}
    if "BEGIN:VCARD" not in payload.upper():
        if re.match(r"(?i)^\s*(https?://|www\.)", payload.strip()):
            url = payload.strip()
            out["website"] = url if url.lower().startswith("http") else "https://" + url
        elif EMAIL_RE.fullmatch(payload.strip()):
            out["email"] = payload.strip().lower()
        return out

    tels: list[tuple[str, str]] = []
    for raw_line in payload.splitlines():
        if ":" not in raw_line:
            continue
        prop, value = raw_line.split(":", 1)
        value = value.strip().replace("\\,", ",").replace("\\;", ";")
        name = prop.split(";")[0].strip().upper()
        params = prop.upper()
        if not value:
            continue
        if name == "FN":
            out["name"] = value
        elif name == "N" and "name" not in out:
            parts = [p.strip() for p in value.split(";")]
            last, first = (parts + ["", ""])[:2]
            out["name"] = _clean(f"{first} {last}")
        elif name == "ORG":
            out["company"] = value.split(";")[0].strip()
        elif name == "TITLE":
            out["job_title"] = value
        elif name == "EMAIL":
            out.setdefault("email", value.lower())
        elif name == "TEL":
            tels.append(("mobile" if "CELL" in params else "fax" if "FAX" in params else "phone", value))
        elif name == "URL":
            out.setdefault("website", value if value.lower().startswith("http") else "https://" + value)
        elif name == "ADR":
            parts = [p.strip() for p in value.split(";") if p.strip()]
            if parts:
                out["address"] = ", ".join(parts)
                out.setdefault("country", parts[-1])

    for want in ("mobile", "phone"):
        for kind, value in tels:
            if kind == want:
                out["phone"] = value
                break
        if "phone" in out:
            break
    return out


# --------------------------------------------------------------------------
# Which card thing does this field want?
# --------------------------------------------------------------------------

Role = Literal[
    "first_name", "last_name", "full_name", "company", "job_title",
    "email", "phone", "mobile", "website", "address", "city", "country", "notes", "unknown",
]

_ROLE_WORDS: list[tuple[Role, tuple[str, ...]]] = [
    ("first_name", ("first name", "firstname", "given name", "forename", "vorname", "prenom", "nombre", "voornaam", "nome proprio")),
    ("last_name", ("last name", "lastname", "surname", "family name", "nachname", "name nom", "apellido", "cognome", "achternaam", "apelido", "sobrenome")),
    ("full_name", ("full name", "name", "contact name", "person", "nom", "nome", "naam")),
    ("job_title", ("job title", "title", "position", "role", "function", "designation", "funktion", "position", "fonction", "cargo", "ruolo", "functie")),
    ("company", ("company", "organisation", "organization", "employer", "firm", "account", "firma", "unternehmen", "entreprise", "societe", "empresa", "azienda", "bedrijf")),
    ("email", ("email", "e mail", "mail", "courriel", "correo", "correio")),
    ("mobile", ("mobile", "cell", "cellphone", "handy", "movil", "cellulare", "telemovel", "gsm", "portable")),
    ("phone", ("phone", "telephone", "tel", "telefon", "telefono", "telefoon", "number", "nummer", "numero")),
    ("website", ("website", "web", "site", "url", "homepage", "webseite", "sitio", "sito")),
    ("address", ("address", "street", "adresse", "strasse", "direccion", "indirizzo", "adres", "morada", "endereco")),
    ("city", ("city", "town", "stadt", "ort", "ville", "ciudad", "citta", "stad", "cidade")),
    ("country", ("country", "land", "pays", "pais", "paese", "nation")),
    ("notes", ("notes", "note", "comment", "remark", "notizen", "bemerkung", "observacoes")),
]


def role_of(spec: FieldSpec) -> Role:
    """Work out what a field is after, from its key, then label, then ai_hint."""
    key = _norm(spec.key)
    for role, words in _ROLE_WORDS:
        if key == _norm(role) or key in {_norm(w) for w in words}:
            return role

    if spec.type == "email":
        return "email"
    if spec.type == "phone":
        return "phone"
    if spec.type == "link":
        return "website"

    haystack = f" {key} {_norm(spec.label)} {_norm(spec.ai_hint)} "
    for role, words in _ROLE_WORDS:
        for w in words:
            if f" {_norm(w)} " in haystack:
                return "mobile" if role == "phone" and "mobil" in haystack else role
    return "unknown"


def _match_by_label(lines: Sequence[Line], spec: FieldSpec) -> Optional[tuple[str, float]]:
    """Unknown custom field: look for its own label printed on the card.

    "Stand: B4-217" with a field labelled "Stand" gives "B4-217".
    """
    needles = [n for n in (_norm(spec.label), _norm(spec.key).replace("_", " "))]
    needles += [w for w in _norm(spec.ai_hint).split() if len(w) > 3]
    needles = [n for n in dict.fromkeys(needles) if len(n) > 2]
    for line in lines:
        n = _norm(line.text)
        for needle in needles:
            if re.search(rf"(?<![a-z]){re.escape(needle)}(?![a-z])", n):
                after = re.split(r"[:：|]", line.text, maxsplit=1)
                if len(after) == 2 and _clean(after[1]):
                    return _clean(after[1]), 0.7
                stripped = re.sub(rf"(?i)(?<![a-z]){re.escape(needle)}(?![a-z])", "", line.text)
                if _clean(stripped):
                    return _clean(stripped), 0.55
    return None


def _match_choice(lines: Sequence[Line], spec: FieldSpec) -> Optional[tuple[str, float]]:
    """A choice field can only ever be one of its options."""
    blob = _norm(" ".join(l.text for l in lines))
    for option in spec.options:
        o = _norm(option)
        if o and re.search(rf"(?<![a-z]){re.escape(o)}(?![a-z])", blob):
            return option, 0.75
    return None


# --------------------------------------------------------------------------
# The whole job
# --------------------------------------------------------------------------


@dataclass
class _Card:
    """Everything the heuristics worked out, before it is mapped onto fields."""

    email: Optional[str] = None
    email_conf: float = 0.0
    website: Optional[str] = None
    website_conf: float = 0.0
    website_why: str = ""
    phone: Optional[str] = None
    phone_conf: float = 0.0
    phone_reason: Optional[str] = None
    mobile: Optional[str] = None
    mobile_conf: float = 0.0
    name: Optional[str] = None
    name_conf: float = 0.0
    name_why: str = ""
    company: Optional[str] = None
    company_conf: float = 0.0
    company_why: str = ""
    job_title: Optional[str] = None
    job_title_conf: float = 0.0
    address: Optional[str] = None
    address_conf: float = 0.0
    country: Optional[str] = None
    country_conf: float = 0.0
    country_why: str = ""


def read_card(lines: Sequence[Line], language: Optional[str] = None) -> _Card:
    """Run every heuristic once; the field mapping then just picks from this."""
    card = _Card()
    used: set[int] = set()

    got_email = find_email(lines)
    if got_email:
        card.email, card.email_conf, idx = got_email
        used.add(idx)

    got_web = find_website(lines, card.email)
    if got_web:
        card.website, card.website_conf, idx = got_web
        card.website_why = "email-domain" if idx < 0 else "on-the-card"
        if idx >= 0:
            used.add(idx)

    calling_code, _cc_why = infer_calling_code(lines, card.website, card.email, language)

    hits = [h for h in find_phones(lines) if h.kind != "fax"]
    for h in hits:
        used.add(h.line_index)
    numbers = []
    for h in hits:
        value, international = normalise_phone(h.raw, calling_code)
        if value:
            numbers.append((h, value, international))

    if numbers:
        mobiles = [n for n in numbers if n[0].kind == "mobile" or _looks_mobile(n[1])]
        chosen = mobiles[0] if mobiles else numbers[0]
        hit, value, international = chosen
        card.phone = value
        if mobiles:
            card.mobile, card.mobile_conf = mobiles[0][1], 0.9
        certainty = 0.9 if mobiles else 0.75
        if len(numbers) > 1 and not mobiles:
            certainty = 0.7
            card.phone_reason = "Two numbers on the card — check which is the mobile"
        elif len(mobiles) > 1:
            certainty = 0.75
            card.phone_reason = "More than one mobile number on the card"
        if not international:
            certainty = min(certainty, 0.65)
            card.phone_reason = "No country code on the card — check the dialling code"
        card.phone_conf = _blend(certainty, hit.ocr_confidence)

    got_name = find_name(lines, card.email, used, card.website)
    if got_name:
        card.name, certainty, idx, card.name_why = got_name
        used.add(idx)
        card.name_conf = _blend(certainty, lines[idx].confidence)

    got_company = find_company(lines, card.email, card.website, used)
    if got_company:
        card.company, certainty, idx, card.company_why = got_company
        used.add(idx)
        card.company_conf = _blend(certainty, lines[idx].confidence)

    # Swap guard: a fallback company that IS the person's full name was stolen from
    # the name fields — drop it rather than store it twice. A legal suffix or a
    # domain match is never a person, so only the pure fallback is suspect.
    if (
        card.company_why == "largest-remaining"
        and card.company
        and card.name
        and _squash(card.company) == _squash(card.name)
    ):
        card.company, card.company_conf, card.company_why = None, 0.0, ""

    got_title = find_job_title(lines, used)
    if got_title:
        card.job_title, certainty, idx = got_title
        used.add(idx)
        card.job_title_conf = _blend(certainty, lines[idx].confidence)

    got_address = find_address(lines, used)
    if got_address:
        card.address, certainty, idxs = got_address
        used.update(idxs)
        ocr = min(lines[i].confidence for i in idxs)
        card.address_conf = _blend(certainty, ocr)

    got_country = find_country(lines, card.phone, card.website, card.email, language)
    if got_country:
        card.country, certainty, card.country_why = got_country
        card.country_conf = _blend(certainty, 1.0)

    return card


_REASONS = {
    "largest-near-top": "Read from the biggest line on the card — check the spelling",
    "largest-remaining": "No legal suffix on the card, so this is a guess at the company",
    "domain-match": "Taken from the web address",
    "site-domain-match": "Matches the website address",
    "email-domain": "Guessed from the email address",
    "web-address": "Worked out from the web address, not printed on the card",
    "phone-prefix": "Worked out from the dialling code",
    "language": "Guessed from the language of the card",
    "label-match": "Matched on the field label printed on the card",
    "choice": "Matched one of the options — check it is the right one",
}


def _put(out: dict[str, Extracted], key: str, value: str, confidence: float, reason: Optional[str] = None) -> None:
    value = _clean(value)
    if not value:
        return
    if confidence < UNSURE_BELOW and not reason:
        reason = "Not certain about this one — please check it"
    out[key] = Extracted(value, round(min(0.99, max(0.05, confidence)), 2), reason if confidence < UNSURE_BELOW else None)


def extract_fields(
    lines: Sequence[Line],
    fields: Sequence[FieldSpec],
    language: Optional[str] = None,
    qr: Optional[str] = None,
) -> dict[str, Extracted]:
    """Fill the company's own fields from the OCR lines (AI-02).

    A QR code on the card wins wherever it has an answer: it is machine-written,
    so there is nothing to misread.
    """
    card = read_card(lines, language)
    qr_values = parse_vcard(qr) if qr else {}
    out: dict[str, Extracted] = {}

    qr_name_first, qr_name_last = split_name(qr_values["name"]) if qr_values.get("name") else ("", "")

    for spec in fields:
        role = role_of(spec)

        # 1. The QR code, if it answers this field.
        qr_key = {
            "first_name": "first_name", "last_name": "last_name", "full_name": "name",
            "company": "company", "job_title": "job_title", "email": "email",
            "phone": "phone", "mobile": "phone", "website": "website",
            "address": "address", "country": "country",
        }.get(role)
        if qr_key == "first_name" and qr_name_first:
            _put(out, spec.key, qr_name_first, 0.97)
            continue
        if qr_key == "last_name" and qr_name_last:
            _put(out, spec.key, qr_name_last, 0.97)
            continue
        if qr_key and qr_values.get(qr_key):
            value = qr_values[qr_key]
            if role in ("phone", "mobile"):
                cc, _ = infer_calling_code(lines, card.website, card.email, language)
                value, _intl = normalise_phone(value, cc)
            _put(out, spec.key, value, 0.97)
            continue

        # 2. The heuristics.
        if role == "email" and card.email:
            _put(out, spec.key, card.email, _blend(0.95, card.email_conf))
        elif role == "website" and card.website:
            _put(out, spec.key, card.website,
                 _blend(0.9 if card.website_why == "on-the-card" else 0.55, card.website_conf),
                 _REASONS.get(card.website_why))
        elif role == "mobile" and (card.mobile or card.phone):
            value = card.mobile or card.phone or ""
            conf = card.mobile_conf and _blend(0.9, 1.0) or card.phone_conf
            _put(out, spec.key, value, conf if card.mobile else min(card.phone_conf, 0.65),
                 None if card.mobile else "No number is marked as the mobile — check this one")
        elif role == "phone" and card.phone:
            prefers_mobile = "mobil" in _norm(spec.ai_hint) or "mobile" in _norm(spec.ai_hint)
            value = card.mobile if (prefers_mobile and card.mobile) else card.phone
            _put(out, spec.key, value or "", card.phone_conf, card.phone_reason)
        elif role in ("full_name",) and card.name:
            _put(out, spec.key, card.name, card.name_conf, _REASONS.get(card.name_why))
        elif role in ("first_name", "last_name") and card.name:
            first, last = split_name(card.name)
            _put(out, spec.key, first if role == "first_name" else last,
                 card.name_conf, _REASONS.get(card.name_why))
        elif role == "company" and card.company:
            _put(out, spec.key, card.company, card.company_conf, _REASONS.get(card.company_why))
        elif role == "job_title" and card.job_title:
            _put(out, spec.key, card.job_title, card.job_title_conf)
        elif role == "address" and card.address:
            _put(out, spec.key, card.address, card.address_conf)
        elif role == "country" and card.country:
            _put(out, spec.key, card.country, card.country_conf, _REASONS.get(card.country_why))
        elif spec.type == "choice":
            hit = _match_choice(lines, spec)
            if hit:
                _put(out, spec.key, hit[0], _blend(hit[1], 1.0), _REASONS["choice"])
        else:
            # 3. Unknown custom field: go looking for its own label on the card.
            hit = _match_by_label(lines, spec)
            if hit:
                _put(out, spec.key, hit[0], _blend(hit[1], 1.0), _REASONS["label-match"])

    return out


def lines_from_text(text: str) -> list[Line]:
    """Plain text with no boxes — every line the same size, top to bottom.

    Only for callers that have nothing better; the box heuristics go quiet.
    """
    out: list[Line] = []
    y = 0.0
    for raw in text.splitlines():
        stripped = raw.strip()
        if len(stripped) > 1:
            out.append(Line(stripped, (0.0, y, 100.0, y + 10.0), 0.5))
            y += 12.0
    return out
