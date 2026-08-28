/*
  # Create Pricing Settings Table

  1. New Table
    - `pricing_settings`
      - `id` (uuid, primary key)
      - `config` (jsonb) - Stores all pricing configuration
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS on `pricing_settings` table
    - Add policies for authenticated users to read and update
*/

CREATE TABLE IF NOT EXISTS pricing_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE pricing_settings ENABLE ROW LEVEL SECURITY;

-- Policies for authenticated users
CREATE POLICY "Authenticated users can read pricing settings"
  ON pricing_settings
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can update pricing settings"
  ON pricing_settings
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can insert pricing settings"
  ON pricing_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Insert default configuration
INSERT INTO pricing_settings (config) VALUES (
  '{
    "fcl": {
      "20ft": {
        "clearance": 0,
        "capacity": {
          "all_bags": 0,
          "mixed": 0,
          "drums": 0
        }
      },
      "40ft": {
        "clearance": 0,
        "capacity": {
          "all_bags": 0,
          "mixed": 0,
          "drums": 0
        }
      }
    },
    "lcl": {
      "freight_per_cbm": 0,
      "clearance_per_cbm": 0,
      "min_chargeable": 1,
      "packaging": {
        "25kg_drum": { "weight": 25, "cbm": 0 },
        "50kg_drum": { "weight": 50, "cbm": 0 },
        "25kg_bag": { "weight": 25, "cbm": 0 }
      }
    },
    "air": {
      "min_weight": 100,
      "min_charge": 0,
      "per_kg_after": 0
    },
    "general": {
      "fx_mode": "auto",
      "fx_buffer_percent": 0,
      "manual_fx_rate": 0
    }
  }'::jsonb
)
ON CONFLICT DO NOTHING;