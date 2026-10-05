# Webhooks sortants

Kotbo peut envoyer les événements d'un serveur Discord vers une URL HTTPS de ton choix : CRM, tableur, n8n, Zapier, backend maison. Les webhooks se règlent dans le dashboard, **Configuration → Webhooks sortants**.

## Requête

Chaque événement part en `POST` avec un corps JSON :

```json
{
  "id": "evt_2bq9k4Yw1sXo0c7T",
  "type": "member.joined",
  "apiVersion": "2026-10-01",
  "createdAt": "2026-10-04T18:00:00.000Z",
  "guildId": "123456789012345678",
  "data": { "userId": "234567890123456789", "userTag": "alice", "joinedAt": "2026-10-04T18:00:00.000Z" }
}
```

En-têtes :

| En-tête | Contenu |
| --- | --- |
| `Kotbo-Signature` | `t=<horodatage>,v1=<signature>` |
| `Kotbo-Event` | Le type, par exemple `member.joined` |
| `Kotbo-Event-Id` | Identifiant stable de l'événement, identique entre les relances et les renvois |
| `Kotbo-Delivery` | Identifiant de cette tentative |
| `Kotbo-Api-Version` | Version du format d'enveloppe |

## Vérifier la signature

La signature est un HMAC-SHA256, en hexadécimal, de la chaîne `"<horodatage>.<corps brut>"` calculé avec le secret du webhook (`whsec_…`). Calcule-la sur le corps **tel que reçu**, avant tout `JSON.parse`, et refuse un horodatage vieux de plus de cinq minutes.

```js
import crypto from 'node:crypto';

export function verifyKotbo(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const received = Buffer.from(parts.v1 ?? '', 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
```

Pendant une rotation de secret, l'ancien secret cesse de fonctionner immédiatement.

## Réponse attendue et relances

- Réponds `2xx` en moins de 10 secondes. Les redirections ne sont pas suivies.
- Sans `2xx`, l'envoi est relancé après 1 min, 5 min, 30 min, 2 h, 6 h, 12 h puis 24 h (8 tentatives sur environ 45 heures).
- Après 40 échecs d'affilée, le webhook est coupé. Il se réactive depuis le dashboard.
- Un même événement peut arriver plusieurs fois (relance après un délai dépassé, renvoi manuel) : dédoublonne avec `Kotbo-Event-Id`.
- L'ordre d'arrivée n'est pas garanti : trie sur `createdAt` si l'ordre compte.

Le journal du dashboard garde chaque tentative 30 jours, avec le corps envoyé et le début de la réponse. Chaque ligne peut être renvoyée.

## Événements

| Type | Quand |
| --- | --- |
| `member.joined` | Un membre rejoint le serveur |
| `member.joined_via_invite` | Arrivée dont l'invitation a été identifiée |
| `member.left` | Un membre quitte le serveur |
| `member.roles_updated` | Des rôles sont ajoutés ou retirés |
| `member.level_up` | Un membre passe un niveau |
| `sanction.applied` | Une sanction est appliquée |
| `sanction.revoked` | Une sanction est levée |
| `automod.triggered` | Une règle d'automodération se déclenche (sans le texte capté) |
| `ticket.created` | Un ticket est ouvert |
| `ticket.closed` | Un ticket est fermé, avec sa durée |
| `ticket.rated` | Un membre note le support reçu |
| `form.submitted` | Une réponse est envoyée à un formulaire |
| `suggestion.created` | Une suggestion est proposée |
| `suggestion.resolved` | Une suggestion est acceptée, refusée ou mise en place |
| `giveaway.winner` | Un membre gagne un concours |
| `giveaway.ended` | Un concours est clôturé |
| `partnership.stage_changed` | Un partenariat change d'étape |
| `channel.created`, `channel.deleted` | Un salon est créé ou supprimé |
| `role.created`, `role.deleted` | Un rôle est créé ou supprimé |
| `webhook.ping` | Envoi de test depuis le dashboard |

S'abonner à « Tous les événements » inclut aussi ceux ajoutés plus tard. Le contenu des messages n'est jamais envoyé. Les exemples de `data` de chaque type sont visibles dans le formulaire du dashboard.

## Sécurité côté Kotbo

L'URL doit être en HTTPS public sur le port 443. Kotbo refuse les adresses privées, locales ou de métadonnées cloud, à l'enregistrement puis avant chaque envoi, et refuse les URL de webhooks Discord, qui attendent un autre format. Le secret est chiffré au repos ; chaque affichage et chaque rotation sont inscrits au journal d'activité du serveur.
