#!/usr/bin/env python3
"""Independent standard-library verification for the asymmetric cubic/Dmax dataset."""
from __future__ import annotations
import json, math
from pathlib import Path

DATASET = Path(__file__).with_name("asymmetric-dmax-reference-v1.json")
EPSILON = 1e-12

def solve(matrix, vector):
    augmented = [row[:] + [vector[i]] for i, row in enumerate(matrix)]
    size = len(vector)
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < EPSILON:
            raise RuntimeError("Singular reference system")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [augmented[row][entry] - factor * augmented[column][entry] for entry in range(size + 1)]
    return [row[-1] for row in augmented]

def main():
    dataset = json.loads(DATASET.read_text(encoding="utf-8"))
    points, expected, tolerance = dataset["points"], dataset["expected"], dataset["tolerance"]
    center = sum(p["watts"] for p in points) / len(points)
    scale = max(abs(p["watts"] - center) for p in points)
    rows = [[1.0, (p["watts"]-center)/scale, ((p["watts"]-center)/scale)**2, ((p["watts"]-center)/scale)**3] for p in points]
    normal = [[sum(row[i]*row[j] for row in rows) for j in range(4)] for i in range(4)]
    target = [sum(rows[k][i]*points[k]["lactate"] for k in range(len(points))) for i in range(4)]
    coefficients = solve(normal, target)
    def predict(watts):
        x = (watts-center)/scale
        return sum(coefficients[p]*x**p for p in range(4))
    mean = sum(p["lactate"] for p in points)/len(points)
    sse = sum((p["lactate"]-predict(p["watts"]))**2 for p in points)
    tss = sum((p["lactate"]-mean)**2 for p in points)
    r_squared = 1.0 - sse/tss
    rmse = math.sqrt(sse/len(points))
    start, end = points[0], points[-1]
    dx, dy = end["watts"]-start["watts"], end["lactate"]-start["lactate"]
    a0, a1, a2, a3 = coefficients
    qa, qb, qc = 3*a3, 2*a2, a1-(dy*scale)/dx
    roots = []
    discriminant = qb*qb-4*qa*qc
    if discriminant >= 0:
        root = math.sqrt(discriminant)
        roots = [(-qb-root)/(2*qa), (-qb+root)/(2*qa)]
    candidates = [start["watts"], end["watts"]] + [center+x*scale for x in roots if start["watts"] < center+x*scale < end["watts"]]
    def distance(watts):
        lactate = predict(watts)
        return abs(dy*watts-dx*lactate+end["watts"]*start["lactate"]-end["lactate"]*start["watts"])/math.hypot(dx,dy)
    dmax_watts = max(candidates, key=lambda watts: (distance(watts), -watts))
    actual = {"wattCenter": center, "wattScale": scale, "coefficients": coefficients, "rSquared": r_squared, "rmse": rmse, "dmaxWatts": dmax_watts, "dmaxLactate": predict(dmax_watts), "maximumDistance": distance(dmax_watts)}
    for key, expected_value in expected.items():
        if key == "searchIntervalWatts":
            continue
        actual_value = actual[key]
        if isinstance(expected_value, list):
            assert all(abs(a-b) <= tolerance for a,b in zip(actual_value, expected_value)), (key, actual_value, expected_value)
        else:
            assert abs(actual_value-expected_value) <= tolerance, (key, actual_value, expected_value)
    print(json.dumps(actual, indent=2, sort_keys=True))

if __name__ == "__main__":
    main()
