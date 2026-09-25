#!/usr/bin/env python3
"""Real Doom, played by our Jev-like decision API — mirroring TypeSafe's
launch demo and the Blocks.ai open replica (ViZDoom, Freedoom IWAD bundled
with the engine).

  # 1. start the decision server
  npm start

  # 2. create the venv with real doom (once)
  python3 -m venv .venv && .venv/bin/pip install vizdoom

  # 3. let the model play
  .venv/bin/python examples/doom-vizdoom.py              # headless, prints the feed
  .venv/bin/python examples/doom-vizdoom.py --watch      # live 640x480 window (HUD + crosshair)
  .venv/bin/python examples/doom-vizdoom.py --random     # seeded random baseline
  .venv/bin/python examples/doom-vizdoom.py --scenario health_gathering

The model never sees pixels: the engine provides object labels, health, ammo,
kills via queries; a small bucketed string goes to the model; the model answers
ONE choice question (which action macro) per decision; the engine applies the
selected Doom buttons for N engine tics. Doom runs at 35 tps; with the man!
odecision roundtrip the game runs slower than real time — same as the
original demos.
"""

import argparse
import json
import math
import os
import statistics
import time
import urllib.request

import vizdoom

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get('JEV_BASE_URL', 'http://localhost:8090')
KEY = os.environ.get('JEV_AUTH_KEY', 'doom-local')

# ---- action macros: labels are the model-facing rubric; values are Doom button masks
# Button order = [TURN_LEFT_RIGHT_DELTA, ATTACK, MOVE_FORWARD, MOVE_LEFT, MOVE_RIGHT]
MACROS = {
    'attack':      [0, 1, 0, 0, 0],
    'turn_left':   [1, 0, 0, 0, 0],
    'turn_right':  [-1, 0, 0, 0, 0],
    'back_off':    [0, 0, 0, 1, 1],   # both strafes = tight dodge wiggle
    'advance':     [0, 0, 1, 0, 0],
    'strafe_left': [0, 0, 0, 1, 0],
    'strafe_right':[0, 0, 0, 0, 1],
}

CRITERIA_AIM = {
    'attack': 'fire ONLY when the sight line reads "on target" (a demon bearing "ahead"); it hits at any range, and looping while off-target wastes the 26 shells',
    'turn_left': 'rotate counterclockwise: track a demon bearing "left" toward the sights, or sweep for incoming demons when the sight is clear',
    'turn_right': 'rotate clockwise: track a demon bearing "right" toward the sights, or sweep the other way — never idle on a clear sight',
}
CRITERIA_FULL = {
    'turn_left': 'rotate counterclockwise: scan the other bearing, or track a target slipping left',
    'turn_right': 'rotate clockwise: scan the other bearing, or track a target slipping right',
    'advance': 'walk forward: only sensible when no threats are visible, to explore',
    'back_off': 'sidestep out of the line of fire: dodge an incoming attack or reposition',
    'attack': 'pull the trigger now: right whenever a demon is visible, keep firing every tick until it dies; wastes ammo otherwise',
    'strafe_left': 'sidestep left: dodge something coming at you from the right or ahead',
    'strafe_right': 'sidestep right: dodge something coming at you from the left or ahead',
}


def build_game(scenario, watch):
    game = vizdoom.DoomGame()
    game.load_config(os.path.join(vizdoom.scenarios_path, f'{scenario}.cfg'))
    game.set_window_visible(bool(watch))
    if watch:
        game.set_screen_resolution(vizdoom.ScreenResolution.RES_640X480)
    game.clear_available_buttons()
    for btn, val in [
        (vizdoom.Button.TURN_LEFT_RIGHT_DELTA, 11),
        (vizdoom.Button.ATTACK, 1),
        (vizdoom.Button.MOVE_FORWARD, 1),
        (vizdoom.Button.MOVE_LEFT, 1),
        (vizdoom.Button.MOVE_RIGHT, 1),
    ]:
        game.add_available_button(btn, val)
    game.set_available_game_variables([
        vizdoom.GameVariable.HEALTH,
        vizdoom.GameVariable.AMMO2,
        vizdoom.GameVariable.KILLCOUNT,
        vizdoom.GameVariable.ANGLE,
    ])
    game.set_labels_buffer_enabled(True)
    game.init()
    return game


def bucket(v, edges, names):
    for edge, name in zip(edges, names):
        if v < edge:
            return name
    return names[-1]


def state_text(game):
    """Small, stable, bucketed state string — only what the decision needs."""
    hp = game.get_game_variable(vizdoom.GameVariable.HEALTH)
    ammo = game.get_game_variable(vizdoom.GameVariable.AMMO2)
    kills = game.get_game_variable(vizdoom.GameVariable.KILLCOUNT)
    angle = game.get_game_variable(vizdoom.GameVariable.ANGLE)
    px = game.get_game_variable(vizdoom.GameVariable.CAMERA_POSITION_X)
    py = game.get_game_variable(vizdoom.GameVariable.CAMERA_POSITION_Y)
    st = game.get_state()
    threats = []
    closest_ahead = None
    for l in (st.labels if st else []):
        dx, dy = l.object_position_x - px, l.object_position_y - py
        dist = math.hypot(dx, dy)
        rel = (math.degrees(math.atan2(dy, dx)) - angle + 180) % 360 - 180
        bearing = 'ahead' if abs(rel) < 12 else ('left' if rel < 0 else 'right')
        rng = bucket(dist, [140, 350], ['close', 'near', 'far'])
        name = l.object_name.lower()
        if name == 'doomplayer':
            continue  # our own sprite
        if 'shot' in name or 'fireball' in name or 'ball' in name:
            threats.append(f'projectile {bearing}-{rng}')
        elif 'chainsaw' in name or 'marine' in name or 'demon' in name or 'monster' in name or 'imp' in name:
            threats.append(f'demon {bearing}-{rng}')
            if bearing == 'ahead' and (closest_ahead is None or dist < closest_ahead):
                closest_ahead = dist
    threats.sort(key=lambda t: ('close' in t, 'near' in t), reverse=True)
    line = f'health={bucket(hp, [30, 60, 90], ["low", "hurt", "fine", "full"])} ammo={ammo:.0f} kills={kills:.0f}'
    line += f'\nthreats: {", ".join(threats[:3]) or "none visible"}'
    line += f'\nsight: {"on target" if closest_ahead is not None else "clear"}  '
    return line


def nearest_threat_rel(game):
    """Rel bearing (deg) of the closest visible demon, or None."""
    angle = game.get_game_variable(vizdoom.GameVariable.ANGLE)
    px = game.get_game_variable(vizdoom.GameVariable.CAMERA_POSITION_X)
    py = game.get_game_variable(vizdoom.GameVariable.CAMERA_POSITION_Y)
    best = None
    st = game.get_state()
    for l in (st.labels if st else []):
        name = l.object_name.lower()
        if name == 'doomplayer' or 'shot' in name or 'ball' in name:
            continue
        dx, dy = l.object_position_x - px, l.object_position_y - py
        rel = (math.degrees(math.atan2(dy, dx)) - angle + 180) % 360 - 180
        d = math.hypot(dx, dy)
        if best is None or d < best[0]:
            best = (d, rel)
    return best


def aim_assist(game, deg_per_tic=8, max_tics=14, tolerance=7):
    """Motor layer: center the nearest visible demon in the crosshair with a
    small iterative closed loop (turn a bit, re-read the label, repeat).
    Returns the final (dist, rel) or None when nothing is visible."""
    th = nearest_threat_rel(game)
    spent = 0
    while th is not None and abs(th[1]) > tolerance and spent < max_tics:
        dist, rel = th
        tics = max(1, min(max_tics - spent, round(abs(rel) / deg_per_tic)))
        # TURN_LEFT_RIGHT_DELTA: positive = turn left; rel > 0 = target to the right
        game.make_action([-1 if rel > 0 else 1, 0, 0, 0, 0], tics)
        spent += tics
        th = nearest_threat_rel(game)
    return th


def decide(state_str, actions, criteria, samples):
    """One choice question per decision, answered by our /v1/systemone."""
    body = json.dumps({
        'state': state_str,
        'model': os.environ.get('MODEL_VERSION', 'jev-latest'),
        'samples': samples,
        'questions': {
            'action': {
                'type': 'choice',
                'instructions': 'You are the marine in a Doom arena holding ground against demons. Which single action do you take this tick?',
                'criteria': criteria,
            },
        },
    }).encode('utf8')
    req = urllib.request.Request(
        f'{BASE}/v1/systemone', data=body,
        headers={'content-type': 'application/json', 'authorization': f'Bearer {KEY}'})
    with urllib.request.urlopen(req, timeout=30) as res:
        data = json.load(res)
    a = data['answers']['action']
    return a['choice'], a['probabilities'], (data['usage']['input_tokens'], data['usage']['output_tokens'])


def main():
    ap = argparse.ArgumentParser(description='Real Doom, driven by the alx-jev decision API')
    ap.add_argument('--scenario', default='defend_the_center',
                    help='vizdoom scenario name (defend_the_center, basic, health_gathering ...)')
    ap.add_argument('--watch', action='store_true', help='open the live 640x480 window')
    ap.add_argument('--random', action='store_true', help='seeded random controller baseline')
    ap.add_argument('--decisions', type=int, default=50, help='decision budget')
    ap.add_argument('--tics', type=int, default=4, help='engine tics per decision')
    ap.add_argument('--samples', type=int, default=4, help='MC samples per decision')
    ap.add_argument('--seed', type=int, default=1337)
    ap.add_argument('--macros', choices=['aim', 'full'], default='aim',
                    help="'aim' (default): scan & shoot only — right for hold-position arenas; "
                         "'full': add movement macros for navigation scenarios")
    args = ap.parse_args()

    import random
    rng = random.Random(args.seed)

    game = build_game(args.scenario, args.watch)
    if args.macros == 'aim':
        actions = ['attack', 'turn_left', 'turn_right']
        criteria = CRITERIA_AIM
    else:
        actions = ['attack', 'turn_left', 'turn_right', 'advance', 'back_off', 'strafe_left', 'strafe_right']
        criteria = CRITERIA_FULL
    game.new_episode()

    latencies, total_tokens = [], 0
    ms = 0.0
    print(f'== alx-jev plays {args.scenario} (real doom, '
          f'{"watch" if args.watch else "headless"}, {"random" if args.random else "jev"}) ==')
    d = 0
    # Phase machine (the Blocks.ai launch-week lesson: "conventional code
    # handles deterministic work"). When the arena around the marine is clear,
    # deterministic code sweeps at engine speed and the model is NOT called;
    # when a demon is visible, the model makes the tactical judgment.
    sweep_dir = -1
    sweep_step = 0
    model_calls = 0
    while d < args.decisions and not game.is_player_dead():
        d += 1
        th_now = nearest_threat_rel(game)
        if th_now is None and not args.random:
            # ---- NAVIGATE phase: deterministic sweep, no model call ----
            sweep_step += 1
            if sweep_step >= 8:            # flip direction every ~8 steps (~176°)
                sweep_dir = -sweep_dir
                sweep_step = 0
            game.make_action([sweep_dir, 0, 0, 0, 0], 6)
            if args.watch:
                print(f'\r{d:03d} {"(sweep)" :<10} {" " * 10}', end='', flush=True)
            else:
                print(f'{d:03d} (sweep)     engine  [model idle: sight clear]')
            if game.is_episode_finished():
                break
            continue

        # ---- COMBAT phase: the model decides (model_calls when a demon is visible) ----
        st = state_text(game)
        if args.random:
            action = rng.choice(actions)
            probs = {}
            ms = 0.0
        else:
            model_calls += 1
            t0 = time.time()
            try:
                action, probs, (tok_in, tok_out) = decide(st, actions, criteria, args.samples)
                total_tokens += tok_in
                ms = (time.time() - t0) * 1000
                latencies.append(ms)
            except Exception as e:
                action = 'turn_right'  # advisory default on upstream failure
                probs = {}
                ms = (time.time() - t0) * 1000
                print(f'  [upstream error: {e} → default {action}]')
        if args.watch:
            print(f'\r{d:03d} {action:<10} {ms:4.0f}ms{" " * 10}', end='', flush=True)
        else:
            top = sorted(probs.items(), key=lambda kv: -kv[1])
            ptxt = ' '.join(f'{k}:{v:.2f}' for k, v in top[:3])
            print(f'{d:03d} {action:<10} {ms:4.0f}ms  [{ptxt}]' if not args.random else f'{d:03d} {action:<10}  (random)')
            print(f'    {st.replace(chr(10), " | ")}')
        th_done = False
        if action == 'attack' and not args.random:
            # motor layer: closed-loop aim onto the closest visible demon FIRST;
            # fire only if the crosshair is actually on it afterwards
            # (trigger discipline — spraying sideways burns the 26 shells)
            th = aim_assist(game)
            if th is not None and th[0] < 900 and abs(th[1]) <= 10:
                game.make_action([0, 1, 0, 0, 0], args.tics)
                th_done = True
            elif not args.watch:
                print('    [held fire: no target in sights]')
        try:
            if not th_done:
                game.make_action(MACROS[action][:len(game.get_available_buttons())], args.tics)
        except (vizdoom.ViZDoomError, vizdoom.vizdoom.ViZDOOMError):
            break   # engine ended the episode (death/timeout) mid-decision
        if game.is_episode_finished():
            break
        if args.watch:
            # render every skipped tic for smooth watching
            for _ in range(args.tics):
                pass

    hp = game.get_game_variable(vizdoom.GameVariable.HEALTH)
    kills = game.get_game_variable(vizdoom.GameVariable.KILLCOUNT)
    dead = game.is_player_dead()
    print(f'\nresult: {"dead" if dead else "alive"} hp={hp:.0f} kills={kills:.0f} decisions={d}')
    if latencies:
        latencies.sort()
        print(f'decision latency: median={statistics.median(latencies):.0f}ms '
              f'p90={latencies[int(len(latencies)*0.9)-1]:.0f}ms (n={len(latencies)})')
    print(f'upstream tokens: ~{total_tokens} input across {model_calls} model decisions')
    game.close()


if __name__ == '__main__':
    main()
