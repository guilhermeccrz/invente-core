"""Converte os fluxos da interface do ComfyUI para o JSON da API.

Roda dentro do pod. Lê o WEB_TOKEN só para falar com o ComfyUI local e não imprime o valor.
"""

import json
import os
import urllib.request
from pathlib import Path

BASE = Path("/workspace/ComfyUI/user/default/workflows")
OUT = Path(os.environ.get("OUT", "/tmp/inventa-workflows"))
FILES = {
    "zimage_t2i": ("image", "image_z_image_turbo.json"),
    "flux2_t2i": ("image", "image_flux2.json"),
    "qwen_image_2_1_t2i": ("image", "image_qwen_image_2_1_t2i.json"),
    "minimax_i2v": ("video", "video_minimax_h3_i2v.json"),
    "wan_animate": ("video", "video_wan_animate2.json"),
}
MEDIA = {"IMAGE", "VIDEO", "AUDIO", "MASK", "LATENT", "MODEL", "CLIP", "VAE", "CONDITIONING"}
SKIP = {"MarkdownNote", "Note", "Reroute"}
MODES = {"fixed", "increment", "decrement", "randomize"}


def token():
    for line in Path("/opt/ai-dock/etc/environment.sh").read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("export WEB_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("WEB_TOKEN ausente")


def object_info():
    request = urllib.request.Request(
        "http://127.0.0.1:8188/object_info",
        headers={"Authorization": "Bearer " + token()},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode())


def parse_link(link):
    if isinstance(link, dict):
        return link["id"], link["origin_id"], link["origin_slot"], link["target_id"], link["target_slot"]
    return link[0], link[1], link[2], link[3], link[4]


def is_widget(spec):
    return isinstance(spec, list) and bool(spec) and (isinstance(spec[0], list) or spec[0] in ("INT", "FLOAT", "STRING", "BOOLEAN"))


def control_after(spec):
    return isinstance(spec, list) and len(spec) > 1 and isinstance(spec[1], dict) and spec[1].get("control_after_generate")


def ordered_specs(info, class_type):
    found = info.get(class_type, {}).get("input", {})
    specs = []
    for section in ("required", "optional"):
        for name, spec in found.get(section, {}).items():
            specs.append((name, spec))
    return specs


def widget_input_name(info, class_type, fallback):
    for name, spec in ordered_specs(info, class_type):
        if is_widget(spec):
            return name
    return fallback


def build_node(node, info):
    class_type = node["type"]
    specs = ordered_specs(info, class_type)
    values = node.get("widgets_values")
    inputs = {}
    linked = {item["name"]: item["link"] for item in node.get("inputs") or [] if item.get("link") is not None}
    if isinstance(values, dict):
        inputs.update(values)
        return inputs, linked, 0
    values = list(values or [])
    index = 0
    known = {name for name, _spec in specs}
    for name, spec in specs:
        if not is_widget(spec):
            continue
        if index >= len(values):
            continue
        value = values[index]
        index += 1
        if control_after(spec) and index < len(values) and values[index] in MODES:
            index += 1
        if name not in linked:
            inputs[name] = value
    # Widget de upload da interface, fora do object_info.
    if index < len(values) and values[index:] == ["image"]:
        index = len(values)
    return inputs, linked, len(values) - index if index < len(values) and name_known(known) else max(0, len(values) - index)


def name_known(_known):
    return True


def convert(workflow, info):
    subs = {sub["id"]: sub for sub in workflow.get("definitions", {}).get("subgraphs", [])}
    links = {parse_link(link)[0]: parse_link(link) for link in workflow.get("links") or []}
    prompt = {}
    outputs = {}
    missing = []
    leftovers = []
    prompt_targets = []
    seed_targets = []

    def add(node, prefix, inner_links, slot_values, input_names):
        class_type = node["type"]
        if class_type in SKIP or node.get("mode") == 4:
            return
        if class_type not in info:
            missing.append(class_type)
            return
        node_id = f"{prefix}{node['id']}"
        inputs, linked, leftover = build_node(node, info)
        if leftover:
            leftovers.append((node_id, class_type, leftover))
        for name, link_id in linked.items():
            _lid, origin_id, origin_slot, _target, _slot = inner_links[link_id]
            if origin_id < 0:
                kind, payload = slot_values[origin_slot]
                if kind == "value":
                    inputs[name] = payload
                elif kind == "link":
                    inputs[name] = {"$link": payload}
                exposed = input_names[origin_slot]
                if exposed in ("text", "prompt"):
                    prompt_targets.append({"node": node_id, "input": name})
                if exposed in ("seed", "noise_seed"):
                    seed_targets.append({"node": node_id, "input": name})
            else:
                inputs[name] = [f"{prefix}{origin_id}", origin_slot]
        prompt[node_id] = {"class_type": class_type, "inputs": inputs}
        for slot, _output in enumerate(node.get("outputs") or []):
            outputs[(int(node["id"]) if prefix == "" else None, slot)]
        return node_id

    for node in workflow["nodes"]:
        if node["type"] in SKIP or node.get("mode") == 4:
            continue
        if node["type"] in subs:
            expand_sub(node, subs[node["type"]], prompt, outputs, info, links, prompt_targets, seed_targets, missing, leftovers)
            continue
        built = build_node(node, info)
        if node["type"] not in info:
            missing.append(node["type"])
            continue
        inputs, linked, leftover = built
        if leftover:
            leftovers.append((str(node["id"]), node["type"], leftover))
        prompt[str(node["id"])] = {"class_type": node["type"], "inputs": inputs}
        for slot, _output in enumerate(node.get("outputs") or []):
            outputs[(node["id"], slot)] = (str(node["id"]), slot)

    for node in workflow["nodes"]:
        if str(node["id"]) not in prompt:
            continue
        for item in node.get("inputs") or []:
            if item.get("link") is None:
                continue
            _lid, origin_id, origin_slot, _target, _slot = links[item["link"]]
            source = outputs.get((origin_id, origin_slot))
            if not source:
                missing.append(f"link:{origin_id}")
                continue
            prompt[str(node["id"])]["inputs"][item["name"]] = [source[0], source[1]]

    unresolved = []
    for node_id, node in prompt.items():
        for name, value in list(node["inputs"].items()):
            if isinstance(value, dict) and "$link" in value:
                _lid, origin_id, origin_slot, _target, _slot = links[value["$link"]]
                source = outputs.get((origin_id, origin_slot))
                if not source:
                    unresolved.append(node_id)
                    continue
                node["inputs"][name] = [source[0], source[1]]
    return prompt, prompt_targets, seed_targets, missing, leftovers, unresolved


def expand_sub(outer, sub, prompt, outputs, info, outer_links, prompt_targets, seed_targets, missing, leftovers):
    prefix = f"{outer['id']}_"
    inner_links = {parse_link(link)[0]: parse_link(link) for link in sub.get("links") or []}
    input_names = [item["name"] for item in sub.get("inputs") or []]
    values = list(outer.get("widgets_values") or [])
    index = 0
    slot_values = {}
    for slot, item in enumerate(outer.get("inputs") or []):
        if item.get("type") in MEDIA:
            if item.get("link") is not None:
                slot_values[slot] = ("link", item["link"])
            else:
                slot_values[slot] = ("none", None)
            continue
        if index >= len(values):
            slot_values[slot] = ("none", None)
            continue
        slot_values[slot] = ("value", values[index])
        index += 1
    for node in sub.get("nodes") or []:
        if node.get("type") in SKIP or node.get("mode") == 4:
            continue
        if node.get("type") not in info:
            missing.append(node.get("type"))
            continue
        inputs, linked, leftover = build_node(node, info)
        node_id = f"{prefix}{node['id']}"
        if leftover:
            leftovers.append((node_id, node["type"], leftover))
        for name, link_id in linked.items():
            _lid, origin_id, origin_slot, _target, _slot = inner_links[link_id]
            if origin_id < 0:
                kind, payload = slot_values.get(origin_slot, ("none", None))
                if kind == "value":
                    inputs[name] = payload
                elif kind == "link":
                    inputs[name] = {"$link": payload}
                exposed = input_names[origin_slot] if origin_slot < len(input_names) else ""
                if exposed in ("text", "prompt"):
                    prompt_targets.append({"node": node_id, "input": name})
                if exposed in ("seed", "noise_seed"):
                    seed_targets.append({"node": node_id, "input": name})
            else:
                inputs[name] = [f"{prefix}{origin_id}", origin_slot]
        prompt[node_id] = {"class_type": node["type"], "inputs": inputs}
    for slot, output in enumerate(sub.get("outputs") or []):
        for link_id in output.get("linkIds") or []:
            _lid, origin_id, origin_slot, _target, _slot = inner_links[link_id]
            outputs[(outer["id"], slot)] = (f"{prefix}{origin_id}", origin_slot)


def loaders(workflow, info):
    image = video = None
    for node in workflow["nodes"]:
        if node["type"] == "LoadImage":
            image = {"node": str(node["id"]), "input": widget_input_name(info, "LoadImage", "image")}
        if node["type"] == "LoadVideo":
            video = {"node": str(node["id"]), "input": widget_input_name(info, "LoadVideo", "file")}
    return image, video


def output_node(workflow):
    subs = {sub["id"]: sub for sub in workflow.get("definitions", {}).get("subgraphs", [])}
    if not subs:
        return None
    generator = max(subs.values(), key=lambda sub: len(sub.get("nodes") or []))["id"]
    links = {parse_link(link)[0]: parse_link(link) for link in workflow.get("links") or []}
    saves = []
    for node in workflow["nodes"]:
        if not str(node["type"]).startswith("Save"):
            continue
        for item in node.get("inputs") or []:
            if item.get("link") is None:
                continue
            _lid, origin_id, _slot, _target, _target_slot = links[item["link"]]
            origin = next((candidate for candidate in workflow["nodes"] if candidate["id"] == origin_id), None)
            if origin and origin.get("type") == generator:
                return str(node["id"])
        saves.append(str(node["id"]))
    return saves[0] if saves else None


def main():
    info = object_info()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for workflow_id, (kind, filename) in FILES.items():
        workflow = json.loads((BASE / filename).read_text(encoding="utf-8"))
        prompt, prompt_targets, seed_targets, missing, leftovers, unresolved = convert(workflow, info)
        image, video = loaders(workflow, info)
        manifest[workflow_id] = {
            "kind": kind,
            "prompt": dedupe(prompt_targets),
            "seeds": dedupe(seed_targets),
            "load_image": image,
            "load_video": video,
            "output_node": output_node(workflow),
        }
        (OUT / f"{workflow_id}.json").write_text(json.dumps(prompt, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(
            workflow_id,
            "nodes",
            len(prompt),
            "prompt",
            manifest[workflow_id]["prompt"],
            "seeds",
            manifest[workflow_id]["seeds"],
            "image",
            image,
            "video",
            video,
            "save",
            manifest[workflow_id]["output_node"],
            "missing",
            sorted(set(missing)),
            "leftover",
            leftovers[:8],
            "unresolved",
            unresolved[:8],
        )
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print("OUTPUT")
    output = Path("/workspace/ComfyUI/output")
    for path in sorted(output.rglob("*")):
        if path.is_file() and not path.name.startswith("_"):
            print(path)


def dedupe(items):
    seen = set()
    result = []
    for item in items:
        key = (item["node"], item["input"])
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


if __name__ == "__main__":
    main()
