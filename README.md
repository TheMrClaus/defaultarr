# Defaulterr

Change the default audio and subtitle streams for items in Plex per user based on codec, language, keywords and more. Customizable with filters and groups. Can run on a schedule or for newly added items using a Tautulli webhook.

## Getting Started

### Deploying with Docker

Defaulterr runs as a single Node.js container. It reads `/config/config.yaml` and writes to `/logs`. The container listens on port `3184`.

#### 1. Prepare the config directory

```bash
mkdir -p /path/to/config /path/to/logs
```

Copy [`config.yaml`](./config.yaml) into `/path/to/config/config.yaml` and edit it. The file must declare a `provider` and a matching provider block. Minimum examples:

```yaml
# Plex
provider: plex
plex:
  server_url: "http://plex:32400"
  owner_name: "yourPlexUser"
  owner_token: "xxxxx"
  client_identifier: "xxxxx"
```

```yaml
# Emby
provider: emby
emby:
  server_url: "http://emby:8096"
  api_key: "xxxxx"
  owner_name: "yourEmbyUser"
```

See [Configuration Overview](#configuration-overview) below for groups, filters, and run settings.

#### 2a. Build from source (required for Emby)

The upstream image `varthe/defaulterr:latest` is Plex-only and does **not** include the Emby provider added in this fork. Build locally:

```bash
git clone https://github.com/TheMrClaus/defaultarr.git
cd defaultarr
docker build -t defaultarr:latest .
```

Compose file:

```yaml
services:
  defaultarr:
    image: defaultarr:latest
    container_name: defaultarr
    hostname: defaultarr
    ports:
      - 3184:3184
    volumes:
      - /path/to/config:/config
      - /path/to/logs:/logs
    environment:
      - TZ=Europe/London
      - LOG_LEVEL=info
    restart: unless-stopped
```

#### 2b. Prebuilt upstream image (Plex only)

If you only need Plex support, you can skip the build step and use the upstream image:

```yaml
services:
  defaulterr:
    image: varthe/defaulterr:latest
    container_name: defaulterr
    hostname: defaulterr
    ports:
      - 3184:3184
    volumes:
      - /path/to/config:/config
      - /path/to/logs:/logs
    environment:
      - TZ=Europe/London
      - LOG_LEVEL=info
    restart: unless-stopped
```

#### 3. Start and verify

```bash
docker compose up -d
docker compose logs -f
```

On startup you should see `Validated and loaded config file` followed by `Server is running on port 3184`. If you hit a schema error, the log will tell you which field failed validation.

#### Webhook endpoints

- Plex via Tautulli: `POST http://<host>:3184/webhook` (see [Tautulli Webhook Integration](#tautulli-webhook-integration)).
- Emby: `POST http://<host>:3184/webhook/emby`. In Emby, go to **Notifications -> Webhooks** and add the URL. The server accepts Emby's native webhook payloads and ignores irrelevant events.

### Unraid Template
Click [here](https://raw.githubusercontent.com/varthe/Defaulterr/refs/heads/main/defaulterr.xml) to download the Unraid template.

### Configuration Overview

Your configuration is defined in `config.yaml`. Below is a breakdown of the required settings and optional configurations.
See [config.yaml](https://github.com/varthe/Defaulterr/blob/main/config.yaml) for an example of an implementation.

#### REQUIRED SETTINGS

Select a provider with the top-level `provider` key (`plex` or `emby`), then fill in the matching block.

**Plex:**

```yaml
provider: plex
plex:
  server_url: "http://plex:32400"  # Your Plex server URL
  owner_name: "yourPlexUser"       # Used to identify the owner so they can be in groups
  owner_token: "xxxxx"             # The server owner's token
  client_identifier: "xxxxx"       # See below for how to obtain
```

**Emby:**

```yaml
provider: emby
emby:
  server_url: "http://emby:8096"   # Your Emby server URL
  api_key: "xxxxx"                 # Admin API key (see below)
  owner_name: "yourEmbyUser"       # Optional; admin user used for server-scoped queries
```

> Legacy flat Plex config (`plex_server_url`, `plex_owner_token`, `plex_client_identifier`, `plex_owner_name`, top-level `managed_users`) is still accepted via a deprecation shim but will be removed in a future release. Migrate to the nested form above.

#### Obtaining the Plex Client Identifier

1. Go to `https://plex.tv/api/resources?X-Plex-Token={your_admin_token}` (replace `{your_admin_token}` with your token).
2. Search for your server and find the `clientIdentifier` value. This **HAS TO** be the server's identifier, not the owner's.

#### Obtaining an Emby API Key

1. In Emby, go to **Dashboard -> Advanced -> API Keys**.
2. Click **New API Key**, give it a name (e.g., `defaultarr`), and copy the generated key into `emby.api_key`.
3. `emby.owner_name` is optional. If set, it must match an Emby username with admin rights on the server. If omitted, the first administrator user returned by `/Users` is used for internal scoped queries.

#### Emby-Specific Behavior

Emby does **not** expose per-item default track APIs. Instead, defaultarr writes user-level preferences on Emby:

- `AudioLanguagePreference` and `SubtitleLanguagePreference` on the user's profile
- `SubtitleMode` (`Default` or `None` when subtitles are explicitly disabled)
- `PlayDefaultAudioTrack = false` so Emby honors your language preferences

Because of this, only the `language` / `languageCode` fields of a matched stream are actually applied. Filters may still use other fields (`codec`, `extendedDisplayTitle`, etc.) to decide **which** stream matches, but the apply step only writes the language preference. defaultarr logs a warning at startup for each filter that uses non-language criteria so you know the effect will not fully mirror a Plex setup. During a run, it also deduplicates per-user writes so the same preference is not POSTed repeatedly.

Supported Emby library collection types: **Movies**, **TV Shows**, **Home Videos** (treated as movies). Other types (Music, Books, etc.) are not supported.

#### RUN SETTINGS

- **dry_run**: Set to `True` to test filters. This mode won't update users and is recommended to verify that your filters work correctly. It overwrites other run settings.
- **partial_run_on_start**: Set to `True` to do a partial run on application start.
  - **WARNING**: The first run may take a LONG time to complete as it will update all existing media. Subsequent runs will only update any new items added since the last run.
- **partial_run_cron_expression**: Specify a cron expression (e.g., `0 3 * * *` for daily at 3:00 AM) to do a partial run on a schedule. You can create and check cron expressions at [https://crontab.guru/](https://crontab.guru/).
- **clean_run_on_start**: Set to `True` to update all existing media on application start. Should only be used if you want to re-apply a new set of filters on your libraries.

#### GROUPS

Groups define collections of users with shared filters:

- Usernames must match **exactly** as they appear in Plex, including capitalization and special characters.
- Managed accounts require additional setup. Read below.
- Optionally, use `$ALL` in place of a username to include all users from your server.

Example:

```yaml
groups:
  serialTranscoders: # Can be named anything
    - varthe
    - UserWithCapitalLetters # EXACTLY like in Plex
    - $ALL # Grabs all users from the server
  subtitleEnjoyers: # Can be named anything
    - varthe
  deafPeople: # Can be named anything
    - varthe
  weebs: # Can be named anything
    - varthe
```

#### MANAGED ACCOUNTS (optional)

To include managed accounts in groups you will need to supply their tokens manually.
See this [comment](https://www.reddit.com/r/PleX/comments/18ihi91/comment/kddct4k/?utm_source=share&utm_medium=web3x&utm_name=web3xcss&utm_term=1&utm_content=share_button) by Blind_Watchman on how to obtain their tokens. You have to do it like this because the regular tokens won't work.

Include them in the config file like below. Use the key (e.g `user1`) in groups.

```yaml
managed_users:
  user1: token
  user2: token
```

#### FILTERS

Filters define how audio and subtitle streams are updated based on specified criteria. The structure in `config.yaml` is as follows:

- **Library Name**: The filter applies to a specific Plex library.
  - **Group Name**: Defines which group the filter targets.
    - **Stream Type**: Can be `audio` or `subtitles`.
      - **include**: Fields that MUST appear in the stream AND include the specified value
      - **exclude**: Fields that MUST NOT appear in the stream OR not be the specified value
      - **on_match**: Specifies filters for the other stream type if a match is found. For example, disable subtitles if a Spanish audio track is matched. Otherwise find Spanish subtitles.

> **Note:** Any field (e.g., `language`, `codec`, `extendedDisplayTitle`) can either be a single value or an array of values. This allows flexibility in filtering criteria by matching multiple options when needed.

Multiple groups and filters can be defined per library, with the first matching filter being applied. If no filters match, the item remains unchanged in Plex. Filters can utilize any property in the stream object returned by Plex. See [example.json](https://github.com/varthe/Defaulterr/blob/main/example.json) for examples.

```yaml
filters:
  Movies: # Library name
    serialTranscoders: # Group name
      audio:
        # Audio Filter 1 - First English audio track that's not TRUEHD/DTS and not a commentary
        - include:
            language: English # Needs to be in the original language, e.g Español for Spanish
            # languageCode: eng # Alternative to the above, e.g. jpn for Japanese
          exclude:
            codec:
              - truehd
              - dts
            extendedDisplayTitle: commentary
        # Audio Filter 2 - Any English track (fallback if the above filter doesn't match)
        - include:
            language: English
    subtitleEnjoyers:
      subtitles:
        # Subtitle Filter 1 - First English track that's not forced
        - include:
            language: English
          exclude:
            extendedDisplayTitle: forced
    deafPeople:
      subtitles:
        # Subtitle Filter 1 - First English SDH track
        - include:
            language: English
            hearingImpaired: true # SDH
  Anime: # Library name
    weebs: # Group name
      audio:
        # Audio Filter 1 - First English track with disabled subtitles
        - include:
            language: English
          on_match:
            subtitles: disabled # Set subtitles to "off" in Plex
        # Audio Filter 2 - Japenese track with English subtitles
        - include:
            languageCode: jpn # Japenese
            on_match:
              subtitles:
                # Full subtitles -> Dialogue subtitles -> Anything without the word "signs"
                - include:
                    language: English
                    extendedDisplayTitle: full
                - include:
                    language: English
                    extendedDisplayTitle: dialogue
                - include:
                    language: English
                  exclude:
                    extendedDisplayTitle: signs
```

### Tautulli Webhook Integration

To automate filter applications for newly added items:

1. Go to **Settings -> Notifications & Newsletters** in Tautulli.
2. Set **Recently Added Notification Delay** to **60** (increase if notifications are firing too early).
3. Navigate to **Settings -> Notification Agents**.
4. Add a new notification agent and select **Webhook**.
5. Use the Defaulterr URL: `http://defaulterr:3184/webhook`.
6. Choose **POST** for the Webhook Method.
7. Enable the **Recently Added** trigger.
8. Paste the following JSON data into **JSON Data**:

```
<movie>
{
  "type": "movie",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</movie>

<show>
{
  "type": "show",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</show>

<season>
{
  "type": "season",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</season>

<episode>
{
  "type": "episode",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</episode>
```

### Emby Webhook Integration

Emby posts its native webhook payloads directly; no middleware is needed. To automate filter applications when new items are added:

1. In Emby, go to **Dashboard -> Notifications**.
2. Click **Add Notification** and select **Webhooks** (built in on recent Emby builds; install the Webhooks plugin first if the option is missing).
3. Set **Url** to `http://defaultarr:3184/webhook/emby` (swap the host for wherever the container is reachable from Emby).
4. Set **Request content type** to `application/json`.
5. Under **Events**, enable at least **New media added to library** (internal event name `library.new`). `item.add`, `media.added`, and `library.added` are also accepted.
6. Leave user / library filters empty unless you want to restrict which items fire the webhook.
7. Save. defaultarr ignores events it does not recognize and responds `200` so Emby will not retry excessively.

When a matching event arrives, defaultarr walks the item's parent chain to figure out which configured library it belongs to, then applies the filters for that library to every user in the relevant groups.
