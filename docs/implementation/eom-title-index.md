# Encyclopedia of Mathematics title index

PRISM's bundled `packages/core/src/arxiv-eom-titles.json` contains 8,591 title labels collected on 2026-11-09. It combines successful archived article URLs from the publisher's `/wiki/` namespace with canonical titles from two archived pages of the publisher's alphabetical index. Titles are decoded, normalized to Unicode NFC, deduplicated, and sorted. The list excludes other wiki namespaces, navigation pages, and figure subpages. It includes article titles only. [Archive URL index](https://web.archive.org/cdx/search/cdx?url=encyclopediaofmath.org%2Fwiki%2F%2A&filter=statuscode%3A200&filter=mimetype%3Atext%2Fhtml&collapse=urlkey&fl=original&output=json&limit=25000), [first alphabetical index page](https://web.archive.org/web/20251008221403/https://encyclopediaofmath.org/wiki/Special:AllPages), [second alphabetical index page](https://web.archive.org/web/20251012171022/https://encyclopediaofmath.org/index.php?title=Special:AllPages&from=Alternant+matrix).

The live site returned HTTP 502 during collection, and the archived alphabetical index lacks some continuation pages. Coverage reflects available captures, including some historical titles and redirects. [Encyclopedia of Mathematics](https://encyclopediaofmath.org/wiki/Main_Page), [publisher license notice](https://encyclopediaofmath.org/wiki/Encyclopedia_of_Mathematics:Copyrights).

```text
SHA-256 63c8af8218d961ee372e5d53ed69ee974d04f85a9863d384d36eaf6de59a051f
```

When the live site is available, run `node scripts/refresh-eom-titles.mjs` from the repository. The script enumerates nonredirect article titles through the publisher's paginated MediaWiki API and replaces the local file after the full fetch passes validation. Review the new count and update the provenance above before sharing a refreshed snapshot. Ranking reads the local file. [MediaWiki Allpages API](https://www.mediawiki.org/wiki/API:Allpages).
