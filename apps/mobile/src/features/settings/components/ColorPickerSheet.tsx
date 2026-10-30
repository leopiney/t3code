import { hexToHsv, hsvToHex, parseHexColor, type HsvColor } from "@t3tools/shared/color";
import { useEffectEvent, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, TextInput, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";

const HUE_STOPS = [
  { offset: 0, color: "#ff0000" },
  { offset: 1 / 6, color: "#ffff00" },
  { offset: 2 / 6, color: "#00ff00" },
  { offset: 3 / 6, color: "#00ffff" },
  { offset: 4 / 6, color: "#0000ff" },
  { offset: 5 / 6, color: "#ff00ff" },
  { offset: 1, color: "#ff0000" },
];
const PLANE_HEIGHT = 180;
const HUE_HEIGHT = 24;
const THUMB = 24;
const HUE_STEP = 10;

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A swatch ringed in every hue: the way into a custom color beside preset swatches. */
export function SpectrumSwatch(props: { readonly color: string; readonly size: number }) {
  const segments = 24;
  const radius = props.size / 2 - 2;
  const arc = (2 * Math.PI * radius) / segments;
  return (
    <Svg width={props.size} height={props.size}>
      {Array.from({ length: segments }, (_, index) => (
        <Circle
          key={index}
          cx={props.size / 2}
          cy={props.size / 2}
          r={radius}
          fill="none"
          stroke={hsvToHex((index * 360) / segments, 1, 1)}
          strokeWidth={4}
          strokeDasharray={[arc + 0.5, 2 * Math.PI * radius]}
          strokeDashoffset={-index * arc}
        />
      ))}
      <Circle cx={props.size / 2} cy={props.size / 2} r={radius - 4} fill={props.color} />
    </Svg>
  );
}

/** Any color: drag on the saturation and brightness area and the hue slider, or paste a hex. */
export function ColorPickerSheet(props: {
  readonly title: string;
  readonly value: string;
  readonly onClose: () => void;
  readonly onDone: (hex: string) => void;
}) {
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(props.value));
  // What the user typed, until a drag replaces it; null shows the picked color.
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [planeWidth, setPlaneWidth] = useState(0);
  const color = hsvToHex(hsv.h, hsv.s, hsv.v);

  const pickPlane = useEffectEvent((x: number, y: number) => {
    if (planeWidth === 0) return;
    setHexDraft(null);
    setHsv((current) => ({
      ...current,
      s: clamp(x / planeWidth),
      v: 1 - clamp(y / PLANE_HEIGHT),
    }));
  });
  const pickHue = useEffectEvent((x: number) => {
    if (planeWidth === 0) return;
    setHexDraft(null);
    setHsv((current) => ({ ...current, h: clamp(x / planeWidth) * 360 }));
  });
  const [gestures] = useState(() => ({
    plane: Gesture.Pan()
      .runOnJS(true)
      .minDistance(0)
      .onBegin((event) => pickPlane(event.x, event.y))
      .onUpdate((event) => pickPlane(event.x, event.y)),
    hue: Gesture.Pan()
      .runOnJS(true)
      .minDistance(0)
      .onBegin((event) => pickHue(event.x))
      .onUpdate((event) => pickHue(event.x)),
  }));

  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <GestureHandlerRootView className="flex-1">
        <KeyboardAvoidingView
          className="flex-1 items-center justify-center bg-backdrop px-6"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="w-full max-w-md gap-4 rounded-3xl bg-screen p-6">
            <View className="flex-row items-center gap-3">
              <AppText accessibilityRole="header" className="flex-1 text-xl font-t3-semibold">
                {props.title}
              </AppText>
              <View
                className="size-[32px] rounded-full border border-border"
                style={{ backgroundColor: color }}
              />
            </View>

            <GestureDetector gesture={gestures.plane}>
              <View
                accessibilityLabel="Saturation and brightness"
                className="overflow-hidden rounded-xl"
                style={{ height: PLANE_HEIGHT }}
                onLayout={(event) => setPlaneWidth(event.nativeEvent.layout.width)}
              >
                <Svg width="100%" height="100%">
                  <Defs>
                    <LinearGradient id="color-picker-white" x1="0" y1="0" x2="1" y2="0">
                      <Stop offset="0" stopColor="#ffffff" stopOpacity={1} />
                      <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
                    </LinearGradient>
                    <LinearGradient id="color-picker-black" x1="0" y1="0" x2="0" y2="1">
                      <Stop offset="0" stopColor="#000000" stopOpacity={0} />
                      <Stop offset="1" stopColor="#000000" stopOpacity={1} />
                    </LinearGradient>
                  </Defs>
                  <Rect width="100%" height="100%" fill={hsvToHex(hsv.h, 1, 1)} />
                  <Rect width="100%" height="100%" fill="url(#color-picker-white)" />
                  <Rect width="100%" height="100%" fill="url(#color-picker-black)" />
                </Svg>
                <View
                  pointerEvents="none"
                  className="absolute rounded-full border-2 border-white"
                  style={{
                    width: THUMB,
                    height: THUMB,
                    left: hsv.s * planeWidth - THUMB / 2,
                    top: (1 - hsv.v) * PLANE_HEIGHT - THUMB / 2,
                    backgroundColor: color,
                  }}
                />
              </View>
            </GestureDetector>

            <GestureDetector gesture={gestures.hue}>
              <View
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel="Hue"
                accessibilityValue={{ min: 0, max: 360, now: Math.round(hsv.h) }}
                accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
                onAccessibilityAction={(event) => {
                  const step = event.nativeEvent.actionName === "increment" ? HUE_STEP : -HUE_STEP;
                  setHexDraft(null);
                  setHsv((current) => ({
                    ...current,
                    h: Math.min(360, Math.max(0, current.h + step)),
                  }));
                }}
                className="justify-center"
                style={{ height: THUMB }}
              >
                <View className="overflow-hidden rounded-full" style={{ height: HUE_HEIGHT }}>
                  <Svg width="100%" height="100%">
                    <Defs>
                      <LinearGradient id="color-picker-hue" x1="0" y1="0" x2="1" y2="0">
                        {HUE_STOPS.map((stop) => (
                          <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
                        ))}
                      </LinearGradient>
                    </Defs>
                    <Rect width="100%" height="100%" fill="url(#color-picker-hue)" />
                  </Svg>
                </View>
                <View
                  pointerEvents="none"
                  className="absolute rounded-full border-2 border-white"
                  style={{
                    width: THUMB,
                    height: THUMB,
                    left: (hsv.h / 360) * planeWidth - THUMB / 2,
                    backgroundColor: hsvToHex(hsv.h, 1, 1),
                  }}
                />
              </View>
            </GestureDetector>

            <TextInput
              accessibilityLabel="Hex color"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-12 rounded-xl bg-subtle px-3 font-mono text-base text-foreground"
              value={hexDraft ?? color}
              onChangeText={(text) => {
                setHexDraft(text);
                const parsed = parseHexColor(text);
                if (parsed) setHsv(hexToHsv(parsed));
              }}
              onBlur={() => setHexDraft(null)}
            />

            <View className="flex-row justify-end gap-3">
              <Button label="Cancel" tone="text" onPress={props.onClose} />
              <Button
                label="Done"
                tone="secondary"
                onPress={() => {
                  props.onDone(color);
                  props.onClose();
                }}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}
