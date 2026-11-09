import AppKit

let path = "/private/var/folders/8f/sthz3w_56w5czfjrq5475vgr0000gn/T/opencode/drone-video-frames-av/frame-11-055.0s.png"
let output = "/private/var/folders/8f/sthz3w_56w5czfjrq5475vgr0000gn/T/opencode/drone-video-frames-av"
let image = NSImage(contentsOfFile: path)!
var rect = CGRect(origin: .zero, size: image.size)
let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)!

let crops: [(String, CGRect)] = [
    ("hud-top.png", CGRect(x: 0, y: 0, width: 1600, height: 170)),
    ("hud-bottom-left.png", CGRect(x: 0, y: 640, width: 520, height: 250)),
    ("hud-bottom-right.png", CGRect(x: 1040, y: 640, width: 560, height: 250)),
    ("hud-reticle.png", CGRect(x: 560, y: 620, width: 520, height: 280)),
    ("hud-props.png", CGRect(x: 0, y: 300, width: 1600, height: 500)),
]

for (name, cropRect) in crops {
    guard let cropped = cg.cropping(to: cropRect) else { continue }
    let rep = NSBitmapImageRep(cgImage: cropped)
    let data = rep.representation(using: .png, properties: [:])!
    try data.write(to: URL(fileURLWithPath: "\(output)/\(name)"))
    print(name, cropped.width, cropped.height)
}
