/* =========================================================================
   MATATU GAME ENGINE — SERVER-AUTHORITATIVE VERSION
   This is the same rules engine from the original single-file game, moved
   server-side so a client can't cheat (can't see other hands, can't force
   an illegal move). The UI never mutates state directly — it only ever
   sends commands over the socket, and the server is the only place
   state actually changes.
   ========================================================================= */

const CONFIG_DEFAULTS = {
  useJokers: true,
  allowStacking: true,
  reverseInsteadOfSkipFor3Plus: false,
  allowWinningOnPowerCard: true,
  cutterMinFraction: 0.15,
  cutterMaxFraction: 0.35,
};

const SPECIAL_RULES = {
  '2':     { effect: 'PICK',        amount: 2, group: 'normalPick' },
  '3':     { effect: 'PICK',        amount: 3, group: 'normalPick' },
  'JOKER': { effect: 'PICK',        amount: 5, group: 'jokerPick'  },
  'J':     { effect: 'SKIP' },
  'A':     { effect: 'CHANGE_SUIT' },
  '8':     { effect: 'QUESTION' },
};

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

let CARD_ID_SEQ = 1;
function makeCard(rank, suit) {
  return { id: 'c' + (CARD_ID_SEQ++), rank, suit };
}

function buildDeck(config) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(makeCard(rank, suit));
  }
  if (config.useJokers) {
    deck.push(makeCard('JOKER', null));
    deck.push(makeCard('JOKER', null));
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isSpecial(card) { return !!SPECIAL_RULES[card.rank]; }
function cardLabel(card) {
  if (card.rank === 'JOKER') return 'Joker';
  return `${card.rank}${SUIT_NAME[card.suit] ? ' of ' + SUIT_NAME[card.suit] : ''}`;
}

class MatatuEngine {
  constructor(config) {
    this.config = { ...CONFIG_DEFAULTS, ...config };
    this._listeners = {};
    this.state = null;
  }

  on(event, cb) { (this._listeners[event] ||= []).push(cb); }
  emit(event, payload) { (this._listeners[event] || []).forEach(cb => cb(payload)); }

  newGame(players) {
    // players: [{id, name}, ...]  (id = socket id or seat index, stable per game)
    let deck = shuffle(buildDeck(this.config));
    const hands = players.map(() => []);
    const HAND_SIZE = this.config.startingHandSize || 5;

    for (let r = 0; r < HAND_SIZE; r++) {
      for (let p = 0; p < players.length; p++) hands[p].push(deck.pop());
    }

    let starter = null;
    const setAside = [];
    while (deck.length) {
      const c = deck.pop();
      if (!isSpecial(c)) { starter = c; break; }
      setAside.push(c);
    }
    deck = shuffle(deck.concat(setAside));
    if (!starter) starter = deck.pop();

    deck = this._seedCutter(deck);

    this.state = {
      players: players.map((p, i) => ({ id: p.id, name: p.name, hand: hands[i] })),
      deck,
      discard: [starter],
      currentPlayerIndex: 0,
      direction: 1,
      pendingPick: null,
      demandedSuit: null,
      awaitingSuitChoice: false,
      awaitingSuitChooserId: null,
      justDrewCard: null,
      winner: null,
      log: [],
      turnCount: 0,
    };

    this._log(`New game started. ${players.length} players, ${this.config.useJokers ? 'with' : 'without'} Jokers.`);
    this._log(`${this.state.players[0].name} leads with ${cardLabel(starter)} on the table.`);
    this.emit('stateChange', this.state);
  }

  _log(msg) {
    this.state.log.push(msg);
    if (this.state.log.length > 200) this.state.log.shift();
  }

  topCard() { return this.state.discard[this.state.discard.length - 1]; }
  currentPlayer() { return this.state.players[this.state.currentPlayerIndex]; }

  _makeCutter() { return { id: 'cutter-' + (CARD_ID_SEQ++), isCutter: true }; }

  _seedCutter(deck) {
    const card = this._makeCutter();
    if (deck.length === 0) { deck.push(card); return deck; }
    const minIdx = Math.floor(deck.length * this.config.cutterMinFraction);
    const maxIdx = Math.max(minIdx + 1, Math.floor(deck.length * this.config.cutterMaxFraction));
    const idx = minIdx + Math.floor(Math.random() * (maxIdx - minIdx));
    deck.splice(idx, 0, card);
    return deck;
  }

  _reshuffleDiscardIntoMarket() {
    const s = this.state;
    if (s.discard.length <= 1) return false;
    const top = s.discard.pop();
    const reclaimed = shuffle(s.discard);
    s.discard = [top];
    s.deck = reclaimed.concat(s.deck);
    s.deck = this._seedCutter(s.deck);
    this._log('The cutter turns up — the discard pile is reshuffled back into the market.');
    return true;
  }

  _drawN(playerIdx, n) {
    const player = this.state.players[playerIdx];
    const drawn = [];
    let guard = 0;
    while (drawn.length < n && guard < 1000) {
      guard++;
      if (this.state.deck.length === 0) {
        const reshuffled = this._reshuffleDiscardIntoMarket();
        if (!reshuffled) break;
        continue;
      }
      const top = this.state.deck[this.state.deck.length - 1];
      if (top.isCutter) {
        this.state.deck.pop();
        this._reshuffleDiscardIntoMarket();
        continue;
      }
      const c = this.state.deck.pop();
      player.hand.push(c);
      drawn.push(c);
    }
    return drawn;
  }

  isValidPlay(card) {
    const s = this.state;
    if (s.pendingPick) {
      if (!this.config.allowStacking) return false;
      const rule = SPECIAL_RULES[card.rank];
      if (!rule || rule.effect !== 'PICK') return false;
      return rule.group === s.pendingPick.group;
    }
    if (s.demandedSuit) {
      if (card.rank === 'A') return true;
      if (card.rank === 'JOKER') return true;
      return card.suit === s.demandedSuit;
    }
    const top = this.topCard();
    if (card.rank === 'A') return true;
    if (card.rank === 'JOKER') return true;
    if (top.rank === 'JOKER') return false;
    return card.rank === top.rank || card.suit === top.suit;
  }

  validPlaysFor(playerIdx) {
    return this.state.players[playerIdx].hand.filter(c => this.isValidPlay(c));
  }

  _advanceTurn(steps = 1) {
    const n = this.state.players.length;
    this.state.currentPlayerIndex =
      (this.state.currentPlayerIndex + this.state.direction * steps + n * steps) % n;
    this.state.justDrewCard = null;
  }

  _checkWin(playerIdx) {
    if (this.state.players[playerIdx].hand.length === 0) {
      this.state.winner = playerIdx;
      this._log(`${this.state.players[playerIdx].name} wins!`);
      this.emit('gameOver', { winner: playerIdx });
      return true;
    }
    return false;
  }

  dispatch(cmd) {
    const s = this.state;
    if (!s || s.winner !== null) return;
    switch (cmd.type) {
      case 'PLAY': return this._handlePlay(cmd);
      case 'DRAW': return this._handleDraw(cmd);
      case 'PASS': return this._handlePass(cmd);
      case 'CHOOSE_SUIT': return this._handleChooseSuit(cmd);
      default: return this.emit('invalidMove', { reason: 'unknown-command', playerIdx: cmd.playerIdx });
    }
  }

  _handlePlay({ playerIdx, cardId }) {
    const s = this.state;
    if (playerIdx !== s.currentPlayerIndex) return this.emit('invalidMove', { reason: 'not-your-turn', playerIdx });
    if (s.awaitingSuitChoice) return this.emit('invalidMove', { reason: 'must-choose-suit-first', playerIdx });
    const player = s.players[playerIdx];
    const card = player.hand.find(c => c.id === cardId);
    if (!card) return this.emit('invalidMove', { reason: 'card-not-in-hand', playerIdx });
    if (!this.isValidPlay(card)) return this.emit('invalidMove', { reason: 'illegal-card', playerIdx });

    if (!this.config.allowWinningOnPowerCard && player.hand.length === 1 && isSpecial(card)) {
      return this.emit('invalidMove', { reason: 'cant-finish-on-power-card', playerIdx });
    }

    player.hand = player.hand.filter(c => c.id !== cardId);
    s.discard.push(card);
    s.demandedSuit = null;
    s.turnCount++;
    this._log(`${player.name} plays ${cardLabel(card)}.`);

    if (this._checkWin(playerIdx)) { this.emit('stateChange', s); return; }

    this._applyEffect(player, card);
    this.emit('stateChange', s);
  }

  _applyEffect(player, card) {
    const s = this.state;
    const rule = SPECIAL_RULES[card.rank];
    if (!rule) { this._advanceTurn(1); return; }

    switch (rule.effect) {
      case 'PICK': {
        if (s.pendingPick && s.pendingPick.group === rule.group) {
          s.pendingPick.amount += rule.amount;
        } else {
          s.pendingPick = { amount: rule.amount, group: rule.group };
        }
        this._log(`Pending pick is now ${s.pendingPick.amount} card(s).`);
        this._advanceTurn(1);
        break;
      }
      case 'SKIP': {
        const n = s.players.length;
        if (this.config.reverseInsteadOfSkipFor3Plus && n > 2) {
          s.direction *= -1;
          this._log('Direction reversed.');
          this._advanceTurn(1);
        } else {
          const skipped = s.players[(s.currentPlayerIndex + s.direction + n) % n];
          this._log(`${skipped.name} is skipped.`);
          this._advanceTurn(2);
        }
        break;
      }
      case 'CHANGE_SUIT': {
        s.awaitingSuitChoice = true;
        s.awaitingSuitChooserId = player.id;
        break;
      }
      case 'QUESTION': {
        this._advanceTurn(1);
        break;
      }
      default:
        this._advanceTurn(1);
    }
  }

  _handleChooseSuit({ playerIdx, suit }) {
    const s = this.state;
    const chooserIdx = s.players.findIndex(p => p.id === s.awaitingSuitChooserId);
    if (!s.awaitingSuitChoice || playerIdx !== chooserIdx) {
      return this.emit('invalidMove', { reason: 'no-suit-choice-pending', playerIdx });
    }
    if (!SUITS.includes(suit)) return this.emit('invalidMove', { reason: 'bad-suit', playerIdx });

    s.demandedSuit = suit;
    s.awaitingSuitChoice = false;
    s.awaitingSuitChooserId = null;
    this._log(`${s.players[playerIdx].name} demands ${SUIT_NAME[suit]}.`);
    this._advanceTurn(1);
    this.emit('stateChange', s);
  }

  _handleDraw({ playerIdx }) {
    const s = this.state;
    if (playerIdx !== s.currentPlayerIndex) return this.emit('invalidMove', { reason: 'not-your-turn', playerIdx });
    if (s.awaitingSuitChoice) return this.emit('invalidMove', { reason: 'must-choose-suit-first', playerIdx });

    if (s.pendingPick) {
      const n = s.pendingPick.amount;
      const drawn = this._drawN(playerIdx, n);
      this._log(`${s.players[playerIdx].name} picks up ${drawn.length} card(s).`);
      s.pendingPick = null;
      this._advanceTurn(1);
      this.emit('stateChange', s);
      return;
    }

    const top = this.topCard();
    if (top.rank === '8' && s.justDrewCard === null) {
      const hasAnswer = this.validPlaysFor(playerIdx).length > 0;
      if (!hasAnswer) {
        this._drawN(playerIdx, 1);
        this._log(`${s.players[playerIdx].name} can't answer the Eight and picks up 1 card.`);
        this._advanceTurn(1);
        this.emit('stateChange', s);
        return;
      }
    }

    if (s.justDrewCard !== null) return this.emit('invalidMove', { reason: 'already-drew-this-turn', playerIdx });
    const drawnCards = this._drawN(playerIdx, 1);
    if (drawnCards.length === 0) {
      this._log(`Market and discard pile are both empty — ${s.players[playerIdx].name} can't draw.`);
      this._advanceTurn(1);
      this.emit('stateChange', s);
      return;
    }
    const drawn = drawnCards[0];
    s.justDrewCard = drawn.id;
    this._log(`${s.players[playerIdx].name} draws a card.`);

    if (!this.isValidPlay(drawn)) this._advanceTurn(1);
    this.emit('stateChange', s);
  }

  _handlePass({ playerIdx }) {
    const s = this.state;
    if (playerIdx !== s.currentPlayerIndex) return this.emit('invalidMove', { reason: 'not-your-turn', playerIdx });
    if (s.justDrewCard === null) return this.emit('invalidMove', { reason: 'must-draw-before-passing', playerIdx });
    this._log(`${s.players[playerIdx].name} passes.`);
    this._advanceTurn(1);
    this.emit('stateChange', s);
  }

  /* Build a per-player "safe" view of state: every other player's hand is
     redacted to just a count. This is what actually makes it a real
     multiplayer game instead of an honor system. */
  viewFor(playerIdx) {
    const s = this.state;
    if (!s) return null;
    return {
      players: s.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        hand: i === playerIdx ? p.hand : undefined,
      })),
      deckCount: s.deck.length,
      topCard: this.topCard(),
      currentPlayerIndex: s.currentPlayerIndex,
      direction: s.direction,
      pendingPick: s.pendingPick,
      demandedSuit: s.demandedSuit,
      awaitingSuitChoice: s.awaitingSuitChoice,
      awaitingSuitChooserId: s.awaitingSuitChooserId,
      justDrewCard: s.players[playerIdx] && s.justDrewCard &&
        s.players[playerIdx].hand.some(c => c.id === s.justDrewCard) ? s.justDrewCard : (
        s.currentPlayerIndex === playerIdx ? s.justDrewCard : null
      ),
      winner: s.winner,
      log: s.log,
      turnCount: s.turnCount,
      you: playerIdx,
    };
  }
}

module.exports = { MatatuEngine, SPECIAL_RULES, SUITS, SUIT_NAME, cardLabel };
