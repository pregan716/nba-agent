`games.parquet` is the small synthetic games-table fixture from
`sports-nba-data/tests/fixtures/legacy-release-v2/tables/games/season=2024-25/phase=regular_season/part-00000.parquet`.
It exercises real Parquet decoding and schedule projection without network access.
Tests construct their manifests from its exact bytes. Other fixture payloads are
constructed in the tests, including tampered objects and unavailable evidence.
