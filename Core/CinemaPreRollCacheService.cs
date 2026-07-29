using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JMSFusion.Core;

public sealed class CinemaPreRollCacheService
{
    private const string CacheFileName = "tmdb-cinema-preroll-cache.json";
    private const string TmdbApiBase = "https://api.themoviedb.org/3";
    private const string TmdbImageBase = "https://image.tmdb.org/t/p/original";
    private const int CacheVersion = 6;
    private const long LibraryTmdbCacheTtlMs = 5 * 60 * 1000;
    private const int MaxItemsPerLocale = 150;
    private const int MaxPagesPerFeed = 8;
    private const int MaxSeedCandidates = MaxItemsPerLocale * 4;
    private const int MaxConcurrentTmdbRequests = 8;
    private const int RecentReleasePastWindowDays = 70;
    private const int UpcomingReleaseFutureWindowDays = 365;
    private static readonly string[] AdultContentMarkers =
    {
        "porn",
        "porno",
        "pornographic",
        "xxx",
        "adult film",
        "adult movie",
        "erotic",
        "erotica",
        "erotik",
        "softcore",
        "hardcore",
        "hentai",
        "onlyfans",
        "jav "
    };
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromHours(24);
    private static readonly HttpClient Http = CreateHttpClient();
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true
    };

    private readonly ILogger<CinemaPreRollCacheService> _logger;
    private readonly ILocalizationManager _localization;
    private readonly ILibraryManager _libraryManager;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private HashSet<int>? _libraryMovieTmdbIdsCache;
    private long _libraryMovieTmdbIdsCacheAtUtc;

    public CinemaPreRollCacheService(
        ILogger<CinemaPreRollCacheService> logger,
        ILocalizationManager localization,
        ILibraryManager libraryManager)
    {
        _logger = logger;
        _localization = localization;
        _libraryManager = libraryManager;
    }

    public sealed class CacheSnapshot
    {
        public string CacheFile { get; set; } = CacheFileName;
        public string CacheKey { get; set; } = string.Empty;
        public string Language { get; set; } = "es-MX";
        public string Region { get; set; } = "MX";
        public long UpdatedAtUtc { get; set; }
        public int TargetItemCount { get; set; }
        public bool Stale { get; set; }
        public List<CacheItem> Items { get; set; } = new();
    }

    public sealed class CacheItem
    {
        public int TmdbId { get; set; }
        public string YoutubeKey { get; set; } = string.Empty;
        public string VideoName { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string Overview { get; set; } = string.Empty;
        public string ReleaseDate { get; set; } = string.Empty;
        public string BackdropUrl { get; set; } = string.Empty;
        public string PosterUrl { get; set; } = string.Empty;
        public string SourceList { get; set; } = string.Empty;
        public string OriginalLanguage { get; set; } = string.Empty;
        public string OfficialRating { get; set; } = string.Empty;
        public int? RatingScore { get; set; }
        public int? RatingSubScore { get; set; }
        public string CertificationCountry { get; set; } = string.Empty;
        public bool Adult { get; set; }
    }

    private sealed class LocaleRequest
    {
        public required string Language { get; init; }
        public required string Region { get; init; }
        public required string CacheKey { get; init; }
        public required string IncludeVideoLanguage { get; init; }
        public required string FallbackMode { get; init; }
        public required string FallbackRegion { get; init; }
    }

    private sealed class CacheFileModel
    {
        public int Version { get; set; } = CacheVersion;
        public Dictionary<string, LocaleCacheModel> Locales { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    }

    private sealed class LocaleCacheModel
    {
        public string CacheKey { get; set; } = string.Empty;
        public string Language { get; set; } = "es-MX";
        public string Region { get; set; } = "MX";
        public long UpdatedAtUtc { get; set; }
        public int TargetItemCount { get; set; }
        public List<CacheItem> Items { get; set; } = new();
    }

    private sealed class TmdbMovieListResponse
    {
        public List<TmdbMovie>? Results { get; set; }

        [JsonPropertyName("total_pages")]
        public int TotalPages { get; set; }
    }

    private sealed class TmdbMovie
    {
        public int Id { get; set; }
        public string? Title { get; set; }

        [JsonPropertyName("original_title")]
        public string? OriginalTitle { get; set; }

        public string? Overview { get; set; }

        [JsonPropertyName("release_date")]
        public string? ReleaseDate { get; set; }

        [JsonPropertyName("backdrop_path")]
        public string? BackdropPath { get; set; }

        [JsonPropertyName("poster_path")]
        public string? PosterPath { get; set; }

        [JsonPropertyName("original_language")]
        public string? OriginalLanguage { get; set; }

        public bool Adult { get; set; }
    }

    private sealed class TmdbReleaseDatesResponse
    {
        public List<TmdbReleaseCountry>? Results { get; set; }
    }

    private sealed class TmdbReleaseCountry
    {
        [JsonPropertyName("iso_3166_1")]
        public string? CountryCode { get; set; }

        [JsonPropertyName("release_dates")]
        public List<TmdbReleaseDate>? ReleaseDates { get; set; }
    }

    private sealed class TmdbReleaseDate
    {
        public string? Certification { get; set; }
        public int Type { get; set; }

        [JsonPropertyName("release_date")]
        public string? ReleaseDate { get; set; }
    }

    private sealed class TmdbVideosResponse
    {
        public List<TmdbVideo>? Results { get; set; }
    }

    private sealed class TmdbVideo
    {
        public string? Site { get; set; }
        public string? Type { get; set; }
        public string? Key { get; set; }
        public string? Name { get; set; }
        public bool Official { get; set; }
        public int Size { get; set; }

        [JsonPropertyName("published_at")]
        public string? PublishedAt { get; set; }
    }

    private sealed class MovieSeed
    {
        public int TmdbId { get; set; }
        public string Title { get; set; } = string.Empty;
        public string Overview { get; set; } = string.Empty;
        public string ReleaseDate { get; set; } = string.Empty;
        public string BackdropUrl { get; set; } = string.Empty;
        public string PosterUrl { get; set; } = string.Empty;
        public string SourceList { get; set; } = string.Empty;
        public string OriginalLanguage { get; set; } = string.Empty;
        public string FeedRegion { get; set; } = string.Empty;
        public bool Adult { get; set; }
    }

    private sealed record CertificationInfo(
        string OfficialRating,
        int? RatingScore,
        int? RatingSubScore,
        string CertificationCountry);

    private sealed class ScoredVideo
    {
        public required TmdbVideo Video { get; init; }
        public required double Score { get; init; }
    }

    public async Task<CacheSnapshot> GetSnapshotAsync(
        string? language,
        string? region,
        string? regionMode,
        string? fallbackMode,
        string? fallbackRegion,
        bool forceRefresh = false,
        CancellationToken ct = default)
    {
        var locale = BuildLocaleRequest(language, region, regionMode, fallbackMode, fallbackRegion);
        var plugin = JMSFusionPlugin.Instance ?? throw new InvalidOperationException("Plugin not available.");

        var fileModel = ReadCacheFile(plugin);
        if (!forceRefresh && TryGetFreshLocaleSnapshot(fileModel, locale.CacheKey, out var fresh))
        {
            return ToSnapshot(fresh, stale: false);
        }

        await _refreshLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            fileModel = ReadCacheFile(plugin);
            if (!forceRefresh && TryGetFreshLocaleSnapshot(fileModel, locale.CacheKey, out fresh))
            {
                return ToSnapshot(fresh, stale: false);
            }

            try
            {
                LocaleCacheModel? existingSnapshot = null;
                if (TryGetLocaleSnapshot(fileModel, locale.CacheKey, out var existing))
                {
                    existingSnapshot = existing;
                }

                var refreshed = await RefreshLocaleSnapshotAsync(plugin.Configuration, locale, existingSnapshot, ct).ConfigureAwait(false);
                if (refreshed is not null)
                {
                    UpsertLocaleSnapshot(fileModel, refreshed);
                    WriteCacheFile(plugin, fileModel);
                    return ToSnapshot(refreshed, stale: false);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Cinema pre-roll cache refresh failed for {CacheKey}", locale.CacheKey);
            }

            if (TryGetLocaleSnapshot(fileModel, locale.CacheKey, out var stale))
            {
                return ToSnapshot(stale, stale: true);
            }

            var empty = new LocaleCacheModel
            {
                CacheKey = locale.CacheKey,
                Language = locale.Language,
                Region = locale.Region,
                UpdatedAtUtc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                TargetItemCount = MaxItemsPerLocale,
                Items = new List<CacheItem>()
            };

            UpsertLocaleSnapshot(fileModel, empty);
            WriteCacheFile(plugin, fileModel);
            return ToSnapshot(empty, stale: true);
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    private static HttpClient CreateHttpClient()
    {
        var client = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(45)
        };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("JMSFusion-CinemaPreRollCache/1.0");
        return client;
    }

    private async Task<LocaleCacheModel?> RefreshLocaleSnapshotAsync(
        JMSFusionConfiguration config,
        LocaleRequest locale,
        LocaleCacheModel? existingSnapshot,
        CancellationToken ct)
    {
        var apiKey = string.IsNullOrWhiteSpace(config?.TmdbApiKey) ? string.Empty : config.TmdbApiKey.Trim();
        if (string.IsNullOrWhiteSpace(apiKey) || string.Equals(apiKey, "CHANGE_ME", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var libraryTmdbIds = GetLibraryMovieTmdbIdSetCached();
        var seeds = await FetchMovieSeedsAsync(apiKey, locale, ct).ConfigureAwait(false);
        seeds = ExcludeLibraryMovieSeeds(seeds, libraryTmdbIds);
        if (seeds.Count == 0)
        {
            return BuildLocaleSnapshot(locale, ExcludeLibraryMovies(NormalizeCacheItems(existingSnapshot?.Items), libraryTmdbIds));
        }

        var refreshedItems = await ResolveTrailerItemsAsync(apiKey, locale, seeds, ct).ConfigureAwait(false);
        refreshedItems = ExcludeLibraryMovies(refreshedItems, libraryTmdbIds);
        if (refreshedItems.Count == 0 && existingSnapshot?.Items?.Count > 0)
        {
            return BuildLocaleSnapshot(locale, ExcludeLibraryMovies(NormalizeCacheItems(existingSnapshot.Items), libraryTmdbIds));
        }

        var mergedItems = MergeRefreshedItemsWithExisting(existingSnapshot?.Items, refreshedItems);
        mergedItems = ExcludeLibraryMovies(mergedItems, libraryTmdbIds);
        return BuildLocaleSnapshot(locale, mergedItems);
    }

    private static LocaleCacheModel BuildLocaleSnapshot(LocaleRequest locale, IReadOnlyList<CacheItem> items)
    {
        return new LocaleCacheModel
        {
            CacheKey = locale.CacheKey,
            Language = locale.Language,
            Region = locale.Region,
            UpdatedAtUtc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            TargetItemCount = MaxItemsPerLocale,
            Items = NormalizeCacheItems(items)
        };
    }

    private async Task<List<MovieSeed>> FetchMovieSeedsAsync(string apiKey, LocaleRequest locale, CancellationToken ct)
    {
        var tasks = new List<Task<List<MovieSeed>>>
        {
            FetchFeedAsync(apiKey, "/movie/now_playing", "now_playing", locale, ct),
            FetchFeedAsync(apiKey, "/movie/upcoming", "upcoming", locale, ct)
        };

        var fallbackLocale = BuildFallbackLocaleRequest(locale);
        if (fallbackLocale is not null)
        {
            tasks.Add(FetchFeedAsync(apiKey, "/movie/now_playing", "fallback_now_playing", fallbackLocale, ct));
            tasks.Add(FetchFeedAsync(apiKey, "/movie/upcoming", "fallback_upcoming", fallbackLocale, ct));
        }

        await Task.WhenAll(tasks).ConfigureAwait(false);

        var merged = new Dictionary<int, MovieSeed>();
        foreach (var seed in tasks.SelectMany(task => task.Result))
        {
            MergeSeed(merged, seed);
        }

        return merged.Values
            .OrderByDescending(seed => ScoreSourceList(seed.SourceList))
            .ThenByDescending(seed => ParseReleaseDate(seed.ReleaseDate))
            .ThenByDescending(seed => seed.TmdbId)
            .Take(MaxSeedCandidates)
            .ToList();
    }

    private async Task<List<MovieSeed>> FetchFeedAsync(
        string apiKey,
        string path,
        string sourceList,
        LocaleRequest locale,
        CancellationToken ct)
    {
        var firstPage = await FetchTmdbJsonAsync<TmdbMovieListResponse>(
            apiKey,
            path,
            new Dictionary<string, string>
            {
                ["language"] = locale.Language,
                ["region"] = locale.Region,
                ["include_adult"] = "false",
                ["page"] = "1"
            },
            ct
        ).ConfigureAwait(false);

        var pages = new List<TmdbMovieListResponse> { firstPage };
        var totalPages = Math.Min(MaxPagesPerFeed, Math.Max(1, firstPage.TotalPages));
        if (totalPages > 1)
        {
            var followUpTasks = Enumerable.Range(2, totalPages - 1)
                .Select(page => SafeFetchFeedPageAsync(apiKey, path, locale, page, ct));

            pages.AddRange((await Task.WhenAll(followUpTasks).ConfigureAwait(false)).Where(page => page is not null)!);
        }

        return pages
            .SelectMany(page => page.Results ?? Enumerable.Empty<TmdbMovie>())
            .Where(movie =>
                movie.Id > 0 &&
                !movie.Adult &&
                IsCurrentTrailerRelease(movie.ReleaseDate) &&
                !LooksAdultContent(movie.Title, movie.OriginalTitle, movie.Overview))
            .Select(movie => new MovieSeed
            {
                TmdbId = movie.Id,
                Title = string.IsNullOrWhiteSpace(movie.Title) ? string.Empty : movie.Title.Trim(),
                Overview = string.IsNullOrWhiteSpace(movie.Overview) ? string.Empty : movie.Overview.Trim(),
                ReleaseDate = string.IsNullOrWhiteSpace(movie.ReleaseDate) ? string.Empty : movie.ReleaseDate.Trim(),
                BackdropUrl = string.IsNullOrWhiteSpace(movie.BackdropPath) ? string.Empty : $"{TmdbImageBase}{movie.BackdropPath}",
                PosterUrl = string.IsNullOrWhiteSpace(movie.PosterPath) ? string.Empty : $"{TmdbImageBase}{movie.PosterPath}",
                SourceList = sourceList,
                OriginalLanguage = TrimOrEmpty(movie.OriginalLanguage).ToLowerInvariant(),
                FeedRegion = locale.Region,
                Adult = movie.Adult
            })
            .ToList();
    }

    private async Task<List<CacheItem>> ResolveTrailerItemsAsync(
        string apiKey,
        LocaleRequest locale,
        IReadOnlyList<MovieSeed> seeds,
        CancellationToken ct)
    {
        var items = new ConcurrentBag<CacheItem>();
        using var concurrency = new SemaphoreSlim(MaxConcurrentTmdbRequests, MaxConcurrentTmdbRequests);

        var tasks = seeds.Select(async seed =>
        {
            await concurrency.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                TmdbVideosResponse videos;
                try
                {
                    videos = await FetchTmdbJsonAsync<TmdbVideosResponse>(
                        apiKey,
                        $"/movie/{seed.TmdbId}/videos",
                        new Dictionary<string, string>
                        {
                            ["language"] = locale.Language,
                            ["include_video_language"] = locale.IncludeVideoLanguage
                        },
                        ct
                    ).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Cinema pre-roll TMDb videos fetch failed for {TmdbId}", seed.TmdbId);
                    return;
                }

                var picked = PickBestTrailerVideo(videos.Results);
                if (picked is null || string.IsNullOrWhiteSpace(picked.Key))
                {
                    return;
                }
                if (seed.Adult || LooksAdultContent(seed.Title, seed.Overview, picked.Name))
                {
                    return;
                }

                var libraryTmdbIds = GetLibraryMovieTmdbIdSetCached();
                if (IsMovieInJellyfinLibrary(seed.TmdbId, libraryTmdbIds))
                {
                    return;
                }

                var certification = await FetchCertificationInfoAsync(apiKey, locale, seed, ct).ConfigureAwait(false);

                items.Add(new CacheItem
                {
                    TmdbId = seed.TmdbId,
                    YoutubeKey = picked.Key.Trim(),
                    VideoName = string.IsNullOrWhiteSpace(picked.Name) ? string.Empty : picked.Name.Trim(),
                    Title = seed.Title,
                    Overview = seed.Overview,
                    ReleaseDate = seed.ReleaseDate,
                    BackdropUrl = seed.BackdropUrl,
                    PosterUrl = seed.PosterUrl,
                    SourceList = seed.SourceList,
                    OriginalLanguage = seed.OriginalLanguage,
                    OfficialRating = certification?.OfficialRating ?? string.Empty,
                    RatingScore = certification?.RatingScore,
                    RatingSubScore = certification?.RatingSubScore,
                    CertificationCountry = certification?.CertificationCountry ?? string.Empty,
                    Adult = seed.Adult
                });
            }
            finally
            {
                concurrency.Release();
            }
        });

        await Task.WhenAll(tasks).ConfigureAwait(false);

        return items
            .GroupBy(item => item.TmdbId)
            .Select(group => group
                .OrderByDescending(item => ScoreSourceList(item.SourceList))
                .ThenByDescending(item => ParseReleaseDate(item.ReleaseDate))
                .First())
            .OrderByDescending(item => ScoreSourceList(item.SourceList))
            .ThenByDescending(item => ParseReleaseDate(item.ReleaseDate))
            .ThenByDescending(item => item.TmdbId)
            .Take(MaxItemsPerLocale)
            .ToList();
    }

    private static List<CacheItem> MergeRefreshedItemsWithExisting(
        IEnumerable<CacheItem>? existingItems,
        IEnumerable<CacheItem>? refreshedItems)
    {
        var existing = NormalizeCacheItems(existingItems);
        var refreshed = NormalizeCacheItems(refreshedItems);
        if (existing.Count == 0)
        {
            return refreshed;
        }

        if (refreshed.Count == 0)
        {
            return existing;
        }

        var refreshedById = refreshed
            .GroupBy(item => item.TmdbId)
            .ToDictionary(group => group.Key, group => group.First());
        var existingIds = existing.Select(item => item.TmdbId).ToHashSet();

        var newItems = refreshed
            .Where(item => !existingIds.Contains(item.TmdbId))
            .ToList();

        var updatedExisting = existing
            .Select(item => refreshedById.TryGetValue(item.TmdbId, out var refreshedItem)
                ? MergeCacheItem(item, refreshedItem)
                : item)
            .ToList();

        return NormalizeCacheItems(newItems.Concat(updatedExisting));
    }

    private static List<CacheItem> NormalizeCacheItems(IEnumerable<CacheItem>? items)
    {
        var output = new List<CacheItem>();
        var seen = new HashSet<int>();

        foreach (var item in items ?? Enumerable.Empty<CacheItem>())
        {
            if (
                item is null ||
                item.TmdbId <= 0 ||
                item.Adult ||
                string.IsNullOrWhiteSpace(item.YoutubeKey) ||
                !IsCurrentTrailerRelease(item.ReleaseDate) ||
                LooksAdultContent(item.Title, item.VideoName, item.Overview))
            {
                continue;
            }

            if (!seen.Add(item.TmdbId))
            {
                continue;
            }

            output.Add(NormalizeCacheItem(item));
            if (output.Count >= MaxItemsPerLocale)
            {
                break;
            }
        }

        return output;
    }

    private static CacheItem NormalizeCacheItem(CacheItem item)
    {
        return new CacheItem
        {
            TmdbId = item.TmdbId,
            YoutubeKey = item.YoutubeKey.Trim(),
            VideoName = TrimOrEmpty(item.VideoName),
            Title = TrimOrEmpty(item.Title),
            Overview = TrimOrEmpty(item.Overview),
            ReleaseDate = TrimOrEmpty(item.ReleaseDate),
            BackdropUrl = TrimOrEmpty(item.BackdropUrl),
            PosterUrl = TrimOrEmpty(item.PosterUrl),
            SourceList = TrimOrEmpty(item.SourceList),
            OriginalLanguage = TrimOrEmpty(item.OriginalLanguage).ToLowerInvariant(),
            OfficialRating = TrimOrEmpty(item.OfficialRating),
            RatingScore = item.RatingScore,
            RatingSubScore = item.RatingSubScore,
            CertificationCountry = TrimOrEmpty(item.CertificationCountry).ToUpperInvariant(),
            Adult = item.Adult
        };
    }

    private static CacheItem MergeCacheItem(CacheItem existing, CacheItem refreshed)
    {
        return new CacheItem
        {
            TmdbId = existing.TmdbId,
            YoutubeKey = PreferText(refreshed.YoutubeKey, existing.YoutubeKey),
            VideoName = PreferText(refreshed.VideoName, existing.VideoName),
            Title = PreferText(refreshed.Title, existing.Title),
            Overview = PreferText(refreshed.Overview, existing.Overview),
            ReleaseDate = PreferText(refreshed.ReleaseDate, existing.ReleaseDate),
            BackdropUrl = PreferText(refreshed.BackdropUrl, existing.BackdropUrl),
            PosterUrl = PreferText(refreshed.PosterUrl, existing.PosterUrl),
            SourceList = PreferText(refreshed.SourceList, existing.SourceList),
            OriginalLanguage = PreferText(refreshed.OriginalLanguage, existing.OriginalLanguage).ToLowerInvariant(),
            OfficialRating = PreferText(refreshed.OfficialRating, existing.OfficialRating),
            RatingScore = refreshed.RatingScore ?? existing.RatingScore,
            RatingSubScore = refreshed.RatingSubScore ?? existing.RatingSubScore,
            CertificationCountry = PreferText(refreshed.CertificationCountry, existing.CertificationCountry).ToUpperInvariant(),
            Adult = existing.Adult || refreshed.Adult
        };
    }

    private static string PreferText(string? preferred, string? fallback)
    {
        var value = TrimOrEmpty(preferred);
        return string.IsNullOrWhiteSpace(value) ? TrimOrEmpty(fallback) : value;
    }

    private static string TrimOrEmpty(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
    }

    private static bool LooksAdultContent(params string?[] values)
    {
        var text = string.Join(" ", values.Select(TrimOrEmpty))
            .ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        return AdultContentMarkers.Any(marker => text.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

    private async Task<CertificationInfo?> FetchCertificationInfoAsync(
        string apiKey,
        LocaleRequest locale,
        MovieSeed seed,
        CancellationToken ct)
    {
        try
        {
            var response = await FetchTmdbJsonAsync<TmdbReleaseDatesResponse>(
                apiKey,
                $"/movie/{seed.TmdbId}/release_dates",
                new Dictionary<string, string>(),
                ct
            ).ConfigureAwait(false);

            return PickCertificationInfo(response.Results, locale, seed);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Cinema pre-roll TMDb release dates fetch failed for {TmdbId}", seed.TmdbId);
            return null;
        }
    }

    private CertificationInfo? PickCertificationInfo(
        IEnumerable<TmdbReleaseCountry>? countries,
        LocaleRequest locale,
        MovieSeed seed)
    {
        var countryList = (countries ?? Enumerable.Empty<TmdbReleaseCountry>())
            .Where(country => !string.IsNullOrWhiteSpace(country.CountryCode))
            .ToList();
        if (countryList.Count == 0)
        {
            return null;
        }

        foreach (var countryCode in BuildCertificationCountryPriority(locale, seed))
        {
            var entry = countryList.FirstOrDefault(country =>
                string.Equals(country.CountryCode, countryCode, StringComparison.OrdinalIgnoreCase));
            var certification = PickBestCertification(entry);
            if (string.IsNullOrWhiteSpace(certification))
            {
                continue;
            }

            return BuildCertificationInfo(certification, countryCode);
        }

        var fallback = countryList
            .Select(country => new
            {
                CountryCode = NormalizeCountry(country.CountryCode),
                Certification = PickBestCertification(country)
            })
            .FirstOrDefault(entry => !string.IsNullOrWhiteSpace(entry.Certification));

        return fallback is null
            ? null
            : BuildCertificationInfo(fallback.Certification, fallback.CountryCode);
    }

    private CertificationInfo BuildCertificationInfo(string certification, string countryCode)
    {
        var normalizedCountry = NormalizeCountry(countryCode);
        var normalizedCertification = TrimOrEmpty(certification);
        var ratingScore = ResolveRatingScore(normalizedCertification, normalizedCountry);
        var officialRating = string.IsNullOrWhiteSpace(normalizedCountry)
            ? normalizedCertification
            : $"{normalizedCountry}-{normalizedCertification}";

        return new CertificationInfo(
            officialRating,
            ratingScore?.Score,
            ratingScore?.SubScore,
            normalizedCountry);
    }

    private MediaBrowser.Model.Entities.ParentalRatingScore? ResolveRatingScore(string certification, string countryCode)
    {
        if (string.IsNullOrWhiteSpace(certification))
        {
            return null;
        }

        var attempts = new[]
        {
            (Rating: certification, Country: countryCode),
            (Rating: string.IsNullOrWhiteSpace(countryCode) ? certification : $"{countryCode}-{certification}", Country: countryCode),
            (Rating: certification, Country: string.Empty)
        };

        foreach (var attempt in attempts)
        {
            try
            {
                var score = _localization.GetRatingScore(attempt.Rating, attempt.Country);
                if (score is not null)
                {
                    return score;
                }
            }
            catch
            {
            }
        }

        var numericScore = InferRatingScore(certification, countryCode);
        return numericScore.HasValue
            ? new MediaBrowser.Model.Entities.ParentalRatingScore(numericScore.Value, null)
            : null;
    }

    private static int? InferRatingScore(string certification, string countryCode)
    {
        var value = TrimOrEmpty(certification).ToUpperInvariant();
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var compact = value.Replace(" ", string.Empty).Replace("_", "-", StringComparison.Ordinal);
        if (compact is "G" or "U" or "E" or "L" or "AL" or "ALL" or "A" or "ATP" or "TE" or "TP" or "0")
        {
            return 0;
        }

        if (compact is "PG")
        {
            return string.Equals(countryCode, "GB", StringComparison.OrdinalIgnoreCase) ? 8 : 7;
        }

        if (compact is "PG-13" or "PG13")
        {
            return 13;
        }

        if (compact is "R")
        {
            return 17;
        }

        if (compact is "NC-17" or "NC17" or "X" or "R18")
        {
            return 18;
        }

        var match = System.Text.RegularExpressions.Regex.Match(compact, @"\d{1,2}");
        if (!match.Success || !int.TryParse(match.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var numeric))
        {
            return null;
        }

        return Math.Clamp(numeric, 0, 18);
    }

    private static string PickBestCertification(TmdbReleaseCountry? country)
    {
        return (country?.ReleaseDates ?? Enumerable.Empty<TmdbReleaseDate>())
            .Select(entry => new
            {
                Certification = TrimOrEmpty(entry.Certification),
                TypeScore = ScoreReleaseDateType(entry.Type),
                ReleaseDate = ParseReleaseDate(entry.ReleaseDate)
            })
            .Where(entry => !string.IsNullOrWhiteSpace(entry.Certification))
            .OrderByDescending(entry => entry.TypeScore)
            .ThenByDescending(entry => entry.ReleaseDate)
            .Select(entry => entry.Certification)
            .FirstOrDefault() ?? string.Empty;
    }

    private static int ScoreReleaseDateType(int type)
    {
        return type switch
        {
            3 => 60,
            2 => 50,
            1 => 40,
            4 => 30,
            5 => 20,
            6 => 10,
            _ => 0
        };
    }

    private static IEnumerable<string> BuildCertificationCountryPriority(LocaleRequest locale, MovieSeed seed)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var candidate in new[]
        {
            seed.FeedRegion,
            locale.Region,
            ExtractRegionFromLanguage(locale.Language),
            "US",
            "GB"
        })
        {
            var country = NormalizeCountry(candidate);
            if (!string.IsNullOrWhiteSpace(country) && seen.Add(country))
            {
                yield return country;
            }
        }
    }

    private async Task<TmdbMovieListResponse?> SafeFetchFeedPageAsync(
        string apiKey,
        string path,
        LocaleRequest locale,
        int page,
        CancellationToken ct)
    {
        try
        {
            return await FetchTmdbJsonAsync<TmdbMovieListResponse>(
                apiKey,
                path,
                new Dictionary<string, string>
                {
                    ["language"] = locale.Language,
                    ["region"] = locale.Region,
                    ["include_adult"] = "false",
                    ["page"] = page.ToString(CultureInfo.InvariantCulture)
                },
                ct
            ).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Cinema pre-roll feed page fetch failed for {Path} page {Page}", path, page);
            return null;
        }
    }

    private static TmdbVideo? PickBestTrailerVideo(IEnumerable<TmdbVideo>? videos)
    {
        var best = (videos ?? Enumerable.Empty<TmdbVideo>())
            .Where(entry =>
                string.Equals(entry.Site, "YouTube", StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(entry.Key))
            .Select(entry =>
            {
                var type = string.IsNullOrWhiteSpace(entry.Type) ? string.Empty : entry.Type.Trim().ToLowerInvariant();
                var score = 0d;
                score += type switch
                {
                    "trailer" => 300d,
                    "teaser" => 180d,
                    "clip" => 120d,
                    _ => 0d
                };
                if (entry.Official)
                {
                    score += 60d;
                }

                score += entry.Size / 10d;

                if (DateTimeOffset.TryParse(entry.PublishedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var publishedAt))
                {
                    score += publishedAt.ToUnixTimeMilliseconds() / 1_000_000_000_000d;
                }

                return new ScoredVideo
                {
                    Video = entry,
                    Score = score
                };
            })
            .OrderByDescending(entry => entry.Score)
            .FirstOrDefault();

        return best?.Video;
    }

    private async Task<T> FetchTmdbJsonAsync<T>(
        string apiKey,
        string path,
        IReadOnlyDictionary<string, string> query,
        CancellationToken ct)
    {
        var url = BuildTmdbUrl(apiKey, path, query);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"TMDb HTTP {(int)response.StatusCode} for {path}");
        }

        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        var payload = await JsonSerializer.DeserializeAsync<T>(stream, JsonOptions, ct).ConfigureAwait(false);
        if (payload is null)
        {
            throw new InvalidOperationException($"TMDb response was empty for {path}");
        }

        return payload;
    }

    private static string BuildTmdbUrl(string apiKey, string path, IReadOnlyDictionary<string, string> query)
    {
        var builder = new UriBuilder($"{TmdbApiBase}{path}");
        var queryParts = new List<string> { $"api_key={Uri.EscapeDataString(apiKey)}" };
        foreach (var pair in query)
        {
            if (string.IsNullOrWhiteSpace(pair.Key) || string.IsNullOrWhiteSpace(pair.Value))
            {
                continue;
            }

            queryParts.Add($"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}");
        }

        builder.Query = string.Join("&", queryParts);
        return builder.ToString();
    }

    private static void MergeSeed(IDictionary<int, MovieSeed> target, MovieSeed seed)
    {
        if (!target.TryGetValue(seed.TmdbId, out var existing))
        {
            target[seed.TmdbId] = seed;
            return;
        }

        if (string.IsNullOrWhiteSpace(existing.Title) && !string.IsNullOrWhiteSpace(seed.Title))
        {
            existing.Title = seed.Title;
        }

        if (string.IsNullOrWhiteSpace(existing.Overview) && !string.IsNullOrWhiteSpace(seed.Overview))
        {
            existing.Overview = seed.Overview;
        }

        if (string.IsNullOrWhiteSpace(existing.ReleaseDate) && !string.IsNullOrWhiteSpace(seed.ReleaseDate))
        {
            existing.ReleaseDate = seed.ReleaseDate;
        }

        if (string.IsNullOrWhiteSpace(existing.BackdropUrl) && !string.IsNullOrWhiteSpace(seed.BackdropUrl))
        {
            existing.BackdropUrl = seed.BackdropUrl;
        }

        if (string.IsNullOrWhiteSpace(existing.PosterUrl) && !string.IsNullOrWhiteSpace(seed.PosterUrl))
        {
            existing.PosterUrl = seed.PosterUrl;
        }

        if (ScoreSourceList(seed.SourceList) > ScoreSourceList(existing.SourceList))
        {
            existing.SourceList = seed.SourceList;
            existing.FeedRegion = seed.FeedRegion;
        }

        if (string.IsNullOrWhiteSpace(existing.OriginalLanguage) && !string.IsNullOrWhiteSpace(seed.OriginalLanguage))
        {
            existing.OriginalLanguage = seed.OriginalLanguage;
        }

        if (string.IsNullOrWhiteSpace(existing.FeedRegion) && !string.IsNullOrWhiteSpace(seed.FeedRegion))
        {
            existing.FeedRegion = seed.FeedRegion;
        }
    }

    private static double ScoreSourceList(string? sourceList)
    {
        return sourceList?.Trim().ToLowerInvariant() switch
        {
            "now_playing" => 4d,
            "upcoming" => 3d,
            "fallback_now_playing" => 2d,
            "fallback_upcoming" => 1d,
            _ => 0d
        };
    }

    private static DateTime ParseReleaseDate(string? raw)
    {
        if (DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
        {
            return parsed.Date;
        }

        return DateTime.MinValue;
    }

    private static bool IsCurrentTrailerRelease(string? raw)
    {
        var releaseDate = ParseReleaseDate(raw);
        if (releaseDate == DateTime.MinValue)
        {
            return false;
        }

        var today = DateTime.UtcNow.Date;
        return releaseDate >= today.AddDays(-RecentReleasePastWindowDays)
            && releaseDate <= today.AddDays(UpcomingReleaseFutureWindowDays);
    }

    private static LocaleRequest BuildLocaleRequest(string? language, string? region, string? regionMode, string? fallbackMode, string? fallbackRegion)
    {
        var normalizedLanguage = NormalizeTmdbLanguage(language);
        var normalizedRegionMode = NormalizeTmdbRegionMode(regionMode);
        var normalizedRegion = normalizedRegionMode switch
        {
            "global" => string.Empty,
            _ => NormalizeTmdbRegion(region, normalizedLanguage)
        };
        var iso639 = normalizedLanguage.Split('-')[0];
        var normalizedFallbackMode = NormalizeTmdbFallbackMode(fallbackMode);
        var normalizedFallbackRegion = NormalizeTmdbFallbackRegion(fallbackRegion);
        var baseCacheKey = string.IsNullOrWhiteSpace(normalizedRegion)
            ? $"{normalizedLanguage}:GLOBAL"
            : $"{normalizedLanguage}:{normalizedRegion}";
        var fallbackCacheKey = normalizedFallbackMode switch
        {
            "global" => "FB-GLOBAL",
            "custom" => $"FB-{normalizedFallbackRegion}",
            _ => "FB-NONE"
        };
        return new LocaleRequest
        {
            Language = normalizedLanguage,
            Region = normalizedRegion,
            CacheKey = $"{baseCacheKey}:{fallbackCacheKey}",
            IncludeVideoLanguage = $"{iso639},en,null",
            FallbackMode = normalizedFallbackMode,
            FallbackRegion = normalizedFallbackRegion
        };
    }

    private static LocaleRequest? BuildFallbackLocaleRequest(LocaleRequest locale)
    {
        if (string.Equals(locale.FallbackMode, "none", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var fallbackRegion = string.Equals(locale.FallbackMode, "global", StringComparison.OrdinalIgnoreCase)
            ? string.Empty
            : NormalizeCountry(locale.FallbackRegion);

        if (string.Equals(locale.Region, fallbackRegion, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var fallbackCacheKey = string.IsNullOrWhiteSpace(fallbackRegion) ? "GLOBAL" : fallbackRegion;
        return new LocaleRequest
        {
            Language = locale.Language,
            Region = fallbackRegion,
            CacheKey = $"{locale.Language}:FALLBACK:{fallbackCacheKey}",
            IncludeVideoLanguage = locale.IncludeVideoLanguage,
            FallbackMode = "none",
            FallbackRegion = string.Empty
        };
    }

    private static string ExtractRegionFromLanguage(string? language)
    {
        var parts = TrimOrEmpty(language).Split('-', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return parts.Length >= 2 ? NormalizeCountry(parts[1]) : string.Empty;
    }

    private static string NormalizeCountry(string? countryCode)
    {
        var value = TrimOrEmpty(countryCode).ToUpperInvariant();
        return value.Length == 2 && value.All(ch => ch is >= 'A' and <= 'Z') ? value : string.Empty;
    }

    private static string NormalizeTmdbRegionMode(string? raw)
    {
        var value = string.IsNullOrWhiteSpace(raw) ? "custom" : raw.Trim().ToLowerInvariant();
        return value switch
        {
            "global" => "global",
            "custom" => "custom",
            _ => "custom"
        };
    }

    private static string NormalizeTmdbFallbackMode(string? raw)
    {
        var value = string.IsNullOrWhiteSpace(raw) ? "custom" : raw.Trim().ToLowerInvariant();
        return value switch
        {
            "none" => "none",
            "global" => "global",
            "region" or "custom" => "custom",
            _ => "custom"
        };
    }

    private static string NormalizeTmdbFallbackRegion(string? raw)
    {
        var normalized = NormalizeCountry(raw);
        return string.IsNullOrWhiteSpace(normalized) ? "US" : normalized;
    }

    private static string NormalizeTmdbLanguage(string? raw)
    {
        var value = string.IsNullOrWhiteSpace(raw) ? "es-MX" : raw.Trim().Replace("_", "-");
        if (System.Text.RegularExpressions.Regex.IsMatch(value, "^[a-z]{2}-[A-Z]{2}$"))
        {
            return value;
        }

        var lower = value.ToLowerInvariant();
        return lower switch
        {
            "en" or "eng" => "en-US",
            "es" or "spa" => "es-MX",
            _ => "es-MX"
        };
    }

    private static string NormalizeTmdbRegion(string? raw, string normalizedLanguage)
    {
        var region = string.IsNullOrWhiteSpace(raw) ? string.Empty : raw.Trim().ToUpperInvariant();
        if (region.Length == 2)
        {
            return region;
        }

        var parts = normalizedLanguage.Split('-');
        if (parts.Length >= 2 && parts[1].Length == 2)
        {
            return parts[1].ToUpperInvariant();
        }

        return "MX";
    }

    private static bool TryGetFreshLocaleSnapshot(CacheFileModel fileModel, string cacheKey, out LocaleCacheModel snapshot)
    {
        if (TryGetLocaleSnapshot(fileModel, cacheKey, out snapshot))
        {
            var updatedAt = DateTimeOffset.FromUnixTimeMilliseconds(snapshot.UpdatedAtUtc);
            if (
                snapshot.TargetItemCount >= MaxItemsPerLocale &&
                (snapshot.Items?.Count ?? 0) >= MaxItemsPerLocale &&
                DateTimeOffset.UtcNow - updatedAt <= RefreshInterval)
            {
                return true;
            }
        }

        snapshot = new LocaleCacheModel();
        return false;
    }

    private static bool TryGetLocaleSnapshot(CacheFileModel fileModel, string cacheKey, out LocaleCacheModel snapshot)
    {
        if (fileModel.Locales.TryGetValue(cacheKey, out var existing) && existing is not null)
        {
            existing.Items = NormalizeCacheItems(existing.Items);
            snapshot = existing;
            return true;
        }

        snapshot = new LocaleCacheModel();
        return false;
    }

    private static void UpsertLocaleSnapshot(CacheFileModel fileModel, LocaleCacheModel snapshot)
    {
        if (fileModel.Locales is null)
        {
            fileModel.Locales = new Dictionary<string, LocaleCacheModel>(StringComparer.OrdinalIgnoreCase);
        }

        var cacheKey = string.IsNullOrWhiteSpace(snapshot.CacheKey)
            ? $"{snapshot.Language}:{(string.IsNullOrWhiteSpace(snapshot.Region) ? "GLOBAL" : snapshot.Region)}"
            : snapshot.CacheKey;

        snapshot.CacheKey = cacheKey;
        snapshot.TargetItemCount = MaxItemsPerLocale;
        snapshot.Items = NormalizeCacheItems(snapshot.Items);

        var reordered = new Dictionary<string, LocaleCacheModel>(StringComparer.OrdinalIgnoreCase)
        {
            [cacheKey] = snapshot
        };

        foreach (var pair in fileModel.Locales)
        {
            if (pair.Value is null || string.Equals(pair.Key, cacheKey, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            reordered[pair.Key] = pair.Value;
        }

        fileModel.Locales = reordered;
    }

    private CacheSnapshot ToSnapshot(LocaleCacheModel snapshot, bool stale)
    {
        var libraryTmdbIds = GetLibraryMovieTmdbIdSetCached();
        return new CacheSnapshot
        {
            CacheKey = snapshot.CacheKey,
            Language = snapshot.Language,
            Region = snapshot.Region,
            UpdatedAtUtc = snapshot.UpdatedAtUtc,
            TargetItemCount = snapshot.TargetItemCount,
            Stale = stale,
            Items = ExcludeLibraryMovies(NormalizeCacheItems(snapshot.Items), libraryTmdbIds)
        };
    }

    private HashSet<int> GetLibraryMovieTmdbIdSetCached()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (_libraryMovieTmdbIdsCache != null && (now - _libraryMovieTmdbIdsCacheAtUtc) < LibraryTmdbCacheTtlMs)
        {
            return _libraryMovieTmdbIdsCache;
        }

        _libraryMovieTmdbIdsCache = BuildLibraryMovieTmdbIdSet();
        _libraryMovieTmdbIdsCacheAtUtc = now;
        return _libraryMovieTmdbIdsCache;
    }

    private HashSet<int> BuildLibraryMovieTmdbIdSet()
    {
        var output = new HashSet<int>();
        try
        {
            var query = new InternalItemsQuery
            {
                Recursive = true,
                IncludeItemTypes = new[] { BaseItemKind.Movie },
                IsMissing = false,
                EnableTotalRecordCount = false
            };

            var items = _libraryManager.GetItemList(query) ?? Array.Empty<BaseItem>();
            foreach (var item in items)
            {
                if (!IsAvailableLibraryItem(item))
                {
                    continue;
                }

                var tmdbId = GetTmdbIdFromItem(item);
                if (tmdbId > 0)
                {
                    output.Add(tmdbId);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Cinema pre-roll Jellyfin library TMDb scan failed");
        }

        return output;
    }

    private static int GetTmdbIdFromItem(BaseItem item)
    {
        if (item?.ProviderIds == null || item.ProviderIds.Count == 0)
        {
            return 0;
        }

        foreach (var key in new[] { "Tmdb", "TMDb", "MovieDb", "TheMovieDb" })
        {
            if (!item.ProviderIds.TryGetValue(key, out var raw))
            {
                continue;
            }

            if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var tmdbId) && tmdbId > 0)
            {
                return tmdbId;
            }
        }

        return 0;
    }

    private static bool IsAvailableLibraryItem(BaseItem? item)
    {
        if (item is null)
        {
            return false;
        }

        if (item.LocationType == LocationType.Virtual)
        {
            return false;
        }

        return item.LocationType == LocationType.FileSystem ||
               !string.IsNullOrWhiteSpace(item.Path) ||
               item.RunTimeTicks > 0;
    }

    private static bool IsMovieInJellyfinLibrary(int tmdbId, HashSet<int> libraryTmdbIds)
    {
        return tmdbId > 0 && libraryTmdbIds.Contains(tmdbId);
    }

    private static List<MovieSeed> ExcludeLibraryMovieSeeds(IReadOnlyList<MovieSeed> seeds, HashSet<int> libraryTmdbIds)
    {
        if (seeds.Count == 0 || libraryTmdbIds.Count == 0)
        {
            return seeds is List<MovieSeed> list ? list : seeds.ToList();
        }

        return seeds
            .Where(seed => !IsMovieInJellyfinLibrary(seed.TmdbId, libraryTmdbIds))
            .ToList();
    }

    private static List<CacheItem> ExcludeLibraryMovies(IReadOnlyList<CacheItem> items, HashSet<int> libraryTmdbIds)
    {
        if (items.Count == 0 || libraryTmdbIds.Count == 0)
        {
            return items is List<CacheItem> list ? list : items.ToList();
        }

        return items
            .Where(item => !IsMovieInJellyfinLibrary(item.TmdbId, libraryTmdbIds))
            .ToList();
    }

    private CacheFileModel ReadCacheFile(JMSFusionPlugin plugin)
    {
        var filePath = GetCacheFilePath(plugin);
        if (!File.Exists(filePath))
        {
            return new CacheFileModel();
        }

        try
        {
            using var stream = File.OpenRead(filePath);
            var parsed = JsonSerializer.Deserialize<CacheFileModel>(stream, JsonOptions) ?? new CacheFileModel();
            if (parsed.Version != CacheVersion)
            {
                return new CacheFileModel();
            }

            parsed.Version = CacheVersion;
            parsed.Locales = parsed.Locales is null
                ? new Dictionary<string, LocaleCacheModel>(StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, LocaleCacheModel>(parsed.Locales, StringComparer.OrdinalIgnoreCase);
            return parsed;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Cinema pre-roll cache file could not be read: {FilePath}", filePath);
            return new CacheFileModel();
        }
    }

    private void WriteCacheFile(JMSFusionPlugin plugin, CacheFileModel model)
    {
        var filePath = GetCacheFilePath(plugin);
        var tmpPath = $"{filePath}.tmp";
        Directory.CreateDirectory(Path.GetDirectoryName(filePath) ?? plugin.GetStorageDirectory());
        model.Version = CacheVersion;

        using (var stream = new FileStream(tmpPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(stream, model, JsonOptions);
        }

        File.Move(tmpPath, filePath, true);
    }

    private static string GetCacheFilePath(JMSFusionPlugin plugin)
    {
        return Path.Combine(plugin.GetStorageDirectory(), CacheFileName);
    }
}
