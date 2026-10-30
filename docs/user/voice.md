# Voice calls with WolfBud

WolfBud is a voice agent you can call from any screen. It knows every thread in every project on
your connected environments, tells you when one finishes or needs you (an approval, a question, a
failure, a usage limit), and acts on your threads when you ask: it can send a prompt now or after the
current turn, stop a thread, approve or decline a request, answer a question, read you a thread, open
a thread, or start a new one in a project.

WolfBud runs on [ElevenLabs](https://elevenlabs.io). A call uses the ElevenLabs account and plan of
the key kept on the environment that places it, and hears about threads on every connected
environment.

## Setting it up

1. Create an ElevenLabs API key with access to ElevenLabs Agents.
2. Open **Settings** > **Voice**, pick the environment that should keep the key, and save it. The
   key stays on that environment; clients only see whether one is set.
3. Select **Set up voice agent** to check the key. This creates an agent named "WolfBud for T3 Code"
   in your ElevenLabs account. Without this step, the first call does it, which takes a few seconds.
4. Turn on **Show WolfBud**. This is a per-device setting.

Calls go through a connected environment that has a key and lets this device start calls, your
primary environment first. During a call, WolfBud shows which one it goes through.

## Calling

Call from WolfBud's card, the command palette (**Call WolfBud**), or `mod+alt+v`. The same shortcut
or command hangs up. Drag the wolf to move it out of your way. On iOS and Android, WolfBud is a call
button.

**Speak updates aloud** in **Settings** > **Voice** chooses what WolfBud says without being asked:
finished work and what needs you, only what needs you, or nothing. Updates it does not speak still
reach it, so you can ask what happened.

## Good to know

- Browsers lend the microphone only to secure pages. Open T3 Code over `https` or on `localhost` to
  call from a browser.
- By voice, WolfBud approves a request once or declines it. Approve for the whole session in the app.
- During a call, ElevenLabs receives your thread titles, statuses, recent messages, and the steps of
  running threads, so the agent can talk about them.
- T3 Code owns the agent's prompt, tools, and voice. Changes you make to those in the ElevenLabs
  dashboard are replaced the next time T3 Code updates the agent.
